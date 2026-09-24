import crypto from 'node:crypto';

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

function hashIntent(intent) {
  return crypto.createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function secretMatches(value, expectedHash) {
  if (!expectedHash) return false;
  const actual = hashSecret(value);
  return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
}

function iso(value) {
  return new Date(value).toISOString();
}

export class ApprovalTestManager {
  constructor({ ttlMs = DEFAULT_APPROVAL_TTL_MS, now = () => Date.now(), audit = null } = {}) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? Number(ttlMs)
      : DEFAULT_APPROVAL_TTL_MS;
    this.now = now;
    this.audit = typeof audit === 'function' ? audit : null;
    this.requests = new Map();
  }

  emit(event, request, extra = {}) {
    try {
      this.audit?.({
        component: 'approval_test',
        event,
        approval_id: request?.approvalId,
        operation_id: request?.operationId,
        state: request?.state,
        device_id: request?.action?.deviceId,
        intent_sha256: request?.intentHash,
        ...extra,
      });
    } catch {}
  }

  prune() {
    const now = this.now();
    for (const [approvalId, request] of this.requests) {
      const active = ['pending', 'approved_retryable'].includes(request.state);
      const terminalAt = request.consumedAt ?? request.unknownAt ?? request.respondedAt ?? request.expiresAt;
      if ((active && request.expiresAt <= now) ||
          (!active && request.state !== 'dispatching' && terminalAt + TERMINAL_RETENTION_MS <= now)) {
        this.emit('expired', request);
        this.requests.delete(approvalId);
      }
    }
  }

  publicRequest(request) {
    return {
      approval_required: ['pending', 'approved_retryable'].includes(request.state),
      approval_id: request.approvalId,
      operation_id: request.operationId,
      state: request.state,
      device_id: request.action.deviceId,
      command: request.action.command,
      shell: request.action.shell,
      timeout_ms: request.action.timeoutMs,
      justification: request.justification,
      expires_at: iso(request.expiresAt),
      intent_sha256: request.intentHash,
    };
  }

  request({ deviceId, justification = '' } = {}) {
    this.prune();
    if (typeof deviceId !== 'string' || !deviceId) throw new Error('deviceId is required.');
    const command = 'hostname';
    const timeout = 30000;
    const intent = {
      type: 'approval_test_exec',
      device_id: deviceId,
      command,
      shell: null,
      timeout_ms: timeout,
    };
    const createdAt = this.now();
    const request = {
      approvalId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      state: 'pending',
      intent,
      intentHash: hashIntent(intent),
      action: Object.freeze({
        deviceId,
        command,
        shell: null,
        timeoutMs: timeout,
      }),
      justification: String(justification || 'Run the fixed read-only WCM hostname approval test?'),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.requests.set(request.approvalId, request);
    this.emit('requested', request);
    return this.publicRequest(request);
  }

  prepareAppApproval(approvalId, { hostSession = null } = {}) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot be presented from state=' + request.state + '.');
    }
    if (request.approvalNonceHash) {
      throw new Error('Approval request is already bound to an approval card.');
    }
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    request.approvalNonceHash = hashSecret(approvalNonce);
    request.hostSession = hostSession ? String(hostSession) : null;
    request.appBoundAt = this.now();
    this.emit('app_bound', request);
    return { request: this.publicRequest(request), approvalNonce };
  }

  assertAppRequest(request, approvalNonce, hostSession) {
    if (!request.approvalNonceHash) throw new Error('Approval request is not bound to an approval card.');
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession && request.hostSession !== String(hostSession || '')) {
      throw new Error('Approval request belongs to a different host session.');
    }
  }

  claim(approvalId, approvalNonce, hostSession = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (!['pending', 'approved_retryable'].includes(request.state)) {
      throw new Error('Approval request cannot dispatch from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    request.state = 'dispatching';
    request.approvedAt ??= this.now();
    request.dispatchStartedAt = this.now();
    this.emit('dispatching', request);
    return { request: this.publicRequest(request), action: { ...request.action } };
  }

  deny(approvalId, approvalNonce, hostSession = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (!['pending', 'approved_retryable'].includes(request.state)) {
      throw new Error('Approval request cannot be denied from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    request.state = 'denied';
    request.respondedAt = this.now();
    this.emit('responded', request, { decision: 'deny' });
    return this.publicRequest(request);
  }

  transition(approvalId, nextState) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'dispatching') {
      throw new Error('Approval request is not dispatching; state=' + request.state + '.');
    }
    request.state = nextState;
    if (nextState === 'consumed') request.consumedAt = this.now();
    if (nextState === 'approved_retryable') request.retryableAt = this.now();
    if (nextState === 'execution_unknown') request.unknownAt = this.now();
    this.emit(nextState, request);
    return this.publicRequest(request);
  }

  markConsumed(approvalId) {
    return this.transition(approvalId, 'consumed');
  }

  markRetryable(approvalId) {
    return this.transition(approvalId, 'approved_retryable');
  }

  markUnknown(approvalId) {
    return this.transition(approvalId, 'execution_unknown');
  }
}

export { DEFAULT_APPROVAL_TTL_MS };
