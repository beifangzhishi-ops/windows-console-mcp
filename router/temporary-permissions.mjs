import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

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

export class TemporaryPermissionManager {
  constructor({
    stateFile = path.resolve(process.cwd(), '.state', 'wcm-temporary-permissions.json'),
    now = () => Date.now(),
    audit = null,
  } = {}) {
    this.stateFile = path.resolve(stateFile);
    this.now = now;
    this.audit = typeof audit === 'function' ? audit : null;
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
    fs.renameSync(tempFile, this.stateFile);
  }

  prune() {
    const now = this.now();
    let changed = false;
    const next = [];
    for (const grant of this.grants) {
      if (grant.revokedAt == null && grant.expiredAt == null && grant.expiresAt <= now) {
        grant.expiredAt = now;
        changed = true;
        this.emit('permission_expired', {
          device_id: grant.deviceId,
          fingerprint: grant.permissionHash.slice(0, 12),
          expires_at: iso(grant.expiresAt),
        });
      }
      const terminalAt = grant.revokedAt ?? grant.expiredAt;
      if (terminalAt != null && terminalAt + TERMINAL_RETENTION_MS <= now) {
        changed = true;
        continue;
      }
      next.push(grant);
    }
    if (changed) {
      this.grants = next;
      this.save();
    }
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
    return this.validate({ permissionId, deviceId, auditUse: false });
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
