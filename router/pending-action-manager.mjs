import crypto from 'node:crypto';

export const DEFAULT_PENDING_APPROVAL_TTL_MS = 15 * 60 * 1000;
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
  return value == null ? null : new Date(value).toISOString();
}

export class PendingActionManager {
  constructor({
    ttlMs = DEFAULT_PENDING_APPROVAL_TTL_MS,
    now = () => Date.now(),
    audit = null,
  } = {}) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? Number(ttlMs)
      : DEFAULT_PENDING_APPROVAL_TTL_MS;
    this.now = now;
    this.audit = audit;
    this.requests = new Map();
    this.pendingApprovalId = null;
  }

  emit(event, request, extra = {}) {
    if (!this.audit) return;
    this.audit({
      event,
      approval_id: request?.approvalId || null,
      operation_id: request?.operationId || null,
      state: request?.state || null,
      intent_sha256: request?.intentHash || null,
      ...extra,
    });
  }

  prune() {
    const now = this.now();
    for (const [approvalId, request] of this.requests) {
      if (request.state === 'pending' && request.expiresAt <= now) {
        this.emit('expired', request);
        if (this.pendingApprovalId === approvalId) this.pendingApprovalId = null;
        this.requests.delete(approvalId);
        continue;
      }
      const terminalAt =
        request.consumedAt ??
        request.unknownAt ??
        request.retryableAt ??
        request.respondedAt ??
        request.supersededAt;
      if (
        request.state !== 'pending' &&
        request.state !== 'dispatching' &&
        terminalAt != null &&
        terminalAt + TERMINAL_RETENTION_MS <= now
      ) {
        this.requests.delete(approvalId);
      }
    }
  }

  publicRequest(request) {
    return {
      approval_required: request.state === 'pending',
      approval_id: request.approvalId,
      operation_id: request.operationId,
      state: request.state,
      device_id: request.action.deviceId,
      tool_name: request.action.toolName,
      action_summary: request.action.summary,
      pending_expires_at: iso(request.expiresAt),
      requested_duration_seconds: request.requestedDurationSeconds ?? null,
      intent_sha256: request.intentHash,
    };
  }

  currentPending() {
    this.prune();
    if (!this.pendingApprovalId) return null;
    const request = this.requests.get(this.pendingApprovalId);
    if (!request || request.state !== 'pending') {
      this.pendingApprovalId = null;
      return null;
    }
    return this.publicRequest(request);
  }

  ensurePending({
    deviceId,
    toolName,
    workerArguments,
    summary = '',
  }) {
    this.prune();
    const existing = this.currentPending();
    if (existing) {
      return { request: existing, owner: false, queued: false };
    }
    if (typeof deviceId !== 'string' || !deviceId) throw new Error('deviceId is required.');
    if (typeof toolName !== 'string' || !toolName) throw new Error('toolName is required.');

    const action = {
      deviceId,
      toolName,
      workerArguments: structuredClone(workerArguments || {}),
      summary: String(summary || toolName),
    };
    const intent = {
      type: 'wcm_tool_call',
      device_id: deviceId,
      tool_name: toolName,
      arguments: action.workerArguments,
    };
    const createdAt = this.now();
    const request = {
      approvalId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      state: 'pending',
      intentHash: hashIntent(intent),
      action,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      requestedDurationSeconds: null,
      approvalNonceHash: null,
      hostSession: null,
    };
    this.requests.set(request.approvalId, request);
    this.pendingApprovalId = request.approvalId;
    this.emit('requested', request);
    return { request: this.publicRequest(request), owner: true, queued: false };
  }

  prepareAppApproval(
    approvalId,
    { hostSession = null, requestedDurationSeconds } = {},
  ) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot be presented from state=' + request.state + '.');
    }
    if (request.approvalNonceHash) {
      if (
        request.requestedDurationSeconds !== requestedDurationSeconds &&
        requestedDurationSeconds != null
      ) {
        throw new Error('Approval duration is already frozen for this approval_id.');
      }
      throw new Error('Approval request is already bound to an approval card.');
    }
    request.requestedDurationSeconds = requestedDurationSeconds;
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    request.approvalNonceHash = hashSecret(approvalNonce);
    request.hostSession = hostSession ? String(hostSession) : null;
    request.appBoundAt = this.now();
    this.emit('app_bound', request, {
      requested_duration_seconds: requestedDurationSeconds,
    });
    return {
      request: this.publicRequest(request),
      approvalNonce,
    };
  }

  assertAppRequest(request, approvalNonce, hostSession) {
    if (!request.approvalNonceHash) {
      throw new Error('Approval request is not bound to an approval card.');
    }
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
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot dispatch from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    if (!Number.isInteger(request.requestedDurationSeconds)) {
      throw new Error('Approval duration was not frozen before resolve.');
    }
    request.state = 'dispatching';
    request.approvedAt = this.now();
    request.dispatchStartedAt = this.now();
    if (this.pendingApprovalId === request.approvalId) this.pendingApprovalId = null;
    this.emit('dispatching', request);
    return {
      request: this.publicRequest(request),
      action: structuredClone(request.action),
      requestedDurationSeconds: request.requestedDurationSeconds,
    };
  }

  deny(approvalId, approvalNonce, hostSession = null) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request cannot be denied from state=' + request.state + '.');
    }
    this.assertAppRequest(request, approvalNonce, hostSession);
    request.state = 'denied';
    request.respondedAt = this.now();
    if (this.pendingApprovalId === request.approvalId) this.pendingApprovalId = null;
    this.emit('responded', request, { decision: 'deny' });
    return this.publicRequest(request);
  }

  transition(approvalId, nextState) {
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

  clearPending(reason = 'policy_changed') {
    this.prune();
    if (!this.pendingApprovalId) return null;
    const request = this.requests.get(this.pendingApprovalId);
    this.pendingApprovalId = null;
    if (!request || request.state !== 'pending') return null;
    request.state = 'superseded';
    request.supersededAt = this.now();
    this.emit('superseded', request, { reason });
    return this.publicRequest(request);
  }

  snapshot() {
    return this.currentPending();
  }
}
