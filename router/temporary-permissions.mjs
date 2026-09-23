import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

function boundedDuration(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secretMatches(value, expectedHex) {
  if (typeof expectedHex !== 'string' || expectedHex.length !== 64) return false;
  const actual = Buffer.from(sha256(value), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function iso(value) {
  return new Date(value).toISOString();
}

function permissionIntent(deviceId, grantTtlMs) {
  return {
    type: 'temporary_permission',
    device_id: String(deviceId),
    scope: 'wcm-router-worker-tools-v1',
    duration_ms: Number(grantTtlMs),
  };
}

export class TemporaryPermissionManager {
  constructor({
    stateFile = path.resolve(process.cwd(), '.state', 'wcm-temporary-permissions.json'),
    grantTtlMs = DEFAULT_GRANT_TTL_MS,
    approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
    now = () => Date.now(),
    audit = null,
  } = {}) {
    this.stateFile = path.resolve(stateFile);
    this.grantTtlMs = boundedDuration(grantTtlMs, DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS);
    this.approvalTtlMs = boundedDuration(
      approvalTtlMs,
      DEFAULT_APPROVAL_TTL_MS,
      MAX_APPROVAL_TTL_MS,
    );
    this.now = now;
    this.audit = typeof audit === 'function' ? audit : null;
    this.requests = new Map();
    this.grants = [];
    this.load();
  }

  emit(event, fields = {}) {
    try {
      this.audit?.({ component: 'temporary_permission', event, ...fields });
    } catch {}
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const grants = Array.isArray(parsed?.grants) ? parsed.grants : [];
      this.grants = grants
        .filter((grant) =>
          grant &&
          typeof grant.permissionHash === 'string' &&
          grant.permissionHash.length === 64 &&
          typeof grant.deviceId === 'string' &&
          Number.isFinite(grant.issuedAt) &&
          Number.isFinite(grant.expiresAt),
        )
        .map((grant) => ({
          permissionHash: grant.permissionHash,
          deviceId: grant.deviceId,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
          revokedAt: Number.isFinite(grant.revokedAt) ? grant.revokedAt : null,
          expiredAt: Number.isFinite(grant.expiredAt) ? grant.expiredAt : null,
        }));
      this.prune();
    } catch (error) {
      this.grants = [];
      this.emit('state_load_failed', { error: String(error?.message || error) });
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tempFile = this.stateFile + '.tmp-' + process.pid + '-' + crypto.randomUUID();
    const body = JSON.stringify({ version: 1, grants: this.grants }, null, 2) + '\n';
    fs.writeFileSync(tempFile, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tempFile, this.stateFile); }
    catch (error) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
      throw error;
    }
  }

  prune() {
    const now = this.now();
    let grantsChanged = false;
    const activeApprovalStates = new Set(['pending', 'approved_retryable']);
    for (const [approvalId, request] of this.requests) {
      const terminalAt = request.consumedAt ??
        request.unknownAt ??
        request.respondedAt ??
        request.expiresAt;
      if (activeApprovalStates.has(request.state) && request.expiresAt <= now) {
        this.requests.delete(approvalId);
        this.emit('permission_approval_expired', {
          approval_id: approvalId,
          operation_id: request.operationId,
          device_id: request.action.deviceId,
        });
        continue;
      }
      if (!activeApprovalStates.has(request.state) &&
          request.state !== 'dispatching' &&
          terminalAt + TERMINAL_RETENTION_MS <= now) {
        this.requests.delete(approvalId);
      }
    }
    const next = [];
    for (const grant of this.grants) {
      if (grant.expiresAt <= now && grant.expiredAt == null) {
        grantsChanged = true;
        grant.expiredAt = grant.expiresAt;
        this.emit('permission_expired', {
          device_id: grant.deviceId,
          fingerprint: grant.permissionHash.slice(0, 12),
          expires_at: iso(grant.expiresAt),
        });
      }
      const terminalAt = grant.revokedAt ?? grant.expiredAt;
      if (terminalAt != null && terminalAt + TERMINAL_RETENTION_MS <= now) {
        grantsChanged = true;
        continue;
      }
      next.push(grant);
    }
    if (grantsChanged) {
      this.grants = next;
      this.save();
    }
  }

  publicRequest(request) {
    return {
      approval_required: request.state === 'pending' || request.state === 'approved_retryable',
      approval_id: request.approvalId,
      operation_id: request.operationId,
      state: request.state,
      device_id: request.action.deviceId,
      justification: request.justification,
      requested_duration_seconds: Math.floor(request.action.grantTtlMs / 1000),
      approval_expires_at: iso(request.expiresAt),
      expires_at: iso(request.expiresAt),
      intent_sha256: request.intentHash,
    };
  }

  request({ deviceId, justification = '', hostSession = null } = {}) {
    this.prune();
    if (typeof deviceId !== 'string' || !deviceId) {
      throw new Error('deviceId is required.');
    }
    const approvalId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const intent = permissionIntent(deviceId, this.grantTtlMs);
    const request = {
      approvalId,
      operationId,
      approvalNonceHash: sha256(approvalNonce),
      intent,
      intentHash: sha256(JSON.stringify(intent)),
      action: Object.freeze({
        deviceId: String(deviceId),
        grantTtlMs: this.grantTtlMs,
        scope: intent.scope,
      }),
      hostSession: hostSession ? String(hostSession) : null,
      justification: String(justification || 'Allow WCM access to this device for 6 hours?'),
      state: 'pending',
      createdAt,
      expiresAt: createdAt + this.approvalTtlMs,
    };
    this.requests.set(approvalId, request);
    this.emit('permission_requested', {
      approval_id: approvalId,
      operation_id: operationId,
      device_id: deviceId,
      intent_sha256: request.intentHash,
      approval_expires_at: iso(request.expiresAt),
    });
    return {
      request: this.publicRequest(request),
      approvalNonce,
    };
  }

  resolve({ approvalId, approvalNonce, decision, hostSession = null } = {}) {
    this.prune();
    const request = this.requests.get(String(approvalId || ''));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (!['pending', 'approved_retryable'].includes(request.state)) {
      throw new Error('Approval request cannot be resolved from state=' + request.state + '.');
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Invalid approval token.');
    }
    if (request.hostSession && hostSession &&
        request.hostSession !== String(hostSession)) {
      throw new Error('Approval request belongs to a different host session.');
    }
    if (!['approve', 'deny'].includes(decision)) {
      throw new Error('decision must be approve or deny.');
    }
    if (decision === 'deny') {
      request.state = 'denied';
      request.respondedAt = this.now();
      this.emit('permission_denied', {
        approval_id: request.approvalId,
        operation_id: request.operationId,
        device_id: request.action.deviceId,
      });
      return this.publicRequest(request);
    }

    request.state = 'dispatching';
    request.approvedAt ??= this.now();
    request.dispatchStartedAt = this.now();
    this.emit('permission_dispatching', {
      approval_id: request.approvalId,
      operation_id: request.operationId,
      device_id: request.action.deviceId,
      intent_sha256: request.intentHash,
    });

    const permissionId = 'wcm_perm_' + crypto.randomBytes(32).toString('base64url');
    const permissionHash = sha256(permissionId);
    const issuedAt = request.approvedAt;
    const grant = {
      permissionHash,
      deviceId: request.action.deviceId,
      issuedAt,
      expiresAt: issuedAt + request.action.grantTtlMs,
      revokedAt: null,
      expiredAt: null,
    };
    this.grants.push(grant);
    try {
      this.save();
    } catch (error) {
      this.grants = this.grants.filter((candidate) => candidate !== grant);
      request.state = 'approved_retryable';
      request.retryableAt = this.now();
      delete request.dispatchStartedAt;
      this.emit('permission_dispatch_failed_prestart', {
        approval_id: request.approvalId,
        operation_id: request.operationId,
        device_id: request.action.deviceId,
        error_name: error?.name || 'Error',
      });
      return {
        ...this.publicRequest(request),
        error: String(error?.message || error),
      };
    }
    request.state = 'consumed';
    request.consumedAt = this.now();
    this.emit('permission_approved', {
      approval_id: request.approvalId,
      operation_id: request.operationId,
      device_id: request.action.deviceId,
      intent_sha256: request.intentHash,
      fingerprint: permissionHash.slice(0, 12),
      expires_at: iso(grant.expiresAt),
    });
    return {
      ...this.publicRequest(request),
      permission_id: permissionId,
      issued_at: iso(grant.issuedAt),
      expires_at: iso(grant.expiresAt),
    };
  }

  findGrant(permissionId) {
    if (typeof permissionId !== 'string' || !permissionId) return null;
    for (const grant of this.grants) {
      if (secretMatches(permissionId, grant.permissionHash)) return grant;
    }
    return null;
  }

  validate({ permissionId, deviceId, auditUse = true } = {}) {
    this.prune();
    const grant = this.findGrant(permissionId);
    if (!grant) {
      this.emit('permission_validation_failed', {
        device_id: deviceId || null,
        reason: 'invalid',
      });
      return { ok: false, state: 'invalid' };
    }
    if (grant.deviceId !== deviceId) {
      this.emit('permission_validation_failed', {
        device_id: deviceId || null,
        fingerprint: grant.permissionHash.slice(0, 12),
        reason: 'device_mismatch',
      });
      return { ok: false, state: 'invalid' };
    }
    if (grant.revokedAt != null) {
      this.emit('permission_validation_failed', {
        device_id: deviceId,
        fingerprint: grant.permissionHash.slice(0, 12),
        reason: 'revoked',
      });
      return { ok: false, state: 'revoked', device_id: grant.deviceId };
    }
    if (grant.expiresAt <= this.now()) {
      this.prune();
      return {
        ok: false,
        state: 'expired',
        device_id: grant.deviceId,
        expires_at: iso(grant.expiresAt),
      };
    }
    if (auditUse) {
      this.emit('permission_used', {
        device_id: deviceId,
        fingerprint: grant.permissionHash.slice(0, 12),
        expires_at: iso(grant.expiresAt),
      });
    }
    return {
      ok: true,
      state: 'active',
      device_id: grant.deviceId,
      issued_at: iso(grant.issuedAt),
      expires_at: iso(grant.expiresAt),
    };
  }

  status({ permissionId, deviceId } = {}) {
    const result = this.validate({ permissionId, deviceId, auditUse: false });
    if (!result.ok) return result;
    return result;
  }

  revoke({ permissionId, deviceId } = {}) {
    this.prune();
    const grant = this.findGrant(permissionId);
    if (!grant || grant.deviceId !== deviceId) {
      return { state: 'invalid', device_id: deviceId || null };
    }
    if (grant.expiresAt <= this.now()) {
      return { state: 'expired', device_id: grant.deviceId, expires_at: iso(grant.expiresAt) };
    }
    if (grant.revokedAt != null) {
      return { state: 'revoked', device_id: grant.deviceId };
    }
    grant.revokedAt = this.now();
    this.emit('permission_revoked', {
      device_id: grant.deviceId,
      fingerprint: grant.permissionHash.slice(0, 12),
    });
    this.save();
    return { state: 'revoked', device_id: grant.deviceId };
  }
}

export const TEMP_PERMISSION_DEFAULT_SECONDS = DEFAULT_GRANT_TTL_MS / 1000;
export const TEMP_PERMISSION_MAX_SECONDS = MAX_GRANT_TTL_MS / 1000;
