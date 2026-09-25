function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

export class TimedGrantManager {
  constructor({ now = () => Date.now(), audit = null } = {}) {
    this.now = now;
    this.audit = audit;
    this.record = null;
  }

  emit(event, record, extra = {}) {
    if (!this.audit) return;
    this.audit({
      event,
      approval_id: record?.approvalId || null,
      operation_id: record?.operationId || null,
      requested_duration_seconds: record?.requestedDurationSeconds || null,
      granted_at: iso(record?.grantedAt),
      expires_at: iso(record?.expiresAt),
      ...extra,
    });
  }

  prune() {
    if (!this.record) return;
    if (this.now() < this.record.expiresAt) return;
    const expired = this.record;
    this.record = null;
    this.emit('grant_expired', expired);
  }

  publicRecord(record = this.record) {
    if (!record) return null;
    const remainingMs = Math.max(0, record.expiresAt - this.now());
    return {
      approval_id: record.approvalId,
      requested_duration_seconds: record.requestedDurationSeconds,
      granted_at: iso(record.grantedAt),
      expires_at: iso(record.expiresAt),
      remaining_seconds: Math.ceil(remainingMs / 1000),
      operation_id: record.operationId,
      policy_revision: record.policyRevision,
    };
  }

  active() {
    this.prune();
    return this.publicRecord();
  }

  grant({
    approvalId,
    requestedDurationSeconds,
    operationId,
    policyRevision = 0,
  }) {
    this.prune();
    if (this.record) {
      throw new Error('A WCM full-access grant is already active.');
    }
    if (typeof approvalId !== 'string' || !approvalId) {
      throw new Error('approvalId is required.');
    }
    if (!Number.isInteger(requestedDurationSeconds) || requestedDurationSeconds <= 0) {
      throw new Error('requestedDurationSeconds must be a positive integer.');
    }
    const grantedAt = this.now();
    this.record = {
      approvalId,
      requestedDurationSeconds,
      grantedAt,
      expiresAt: grantedAt + requestedDurationSeconds * 1000,
      operationId: String(operationId || ''),
      policyRevision: Number(policyRevision || 0),
    };
    this.emit('grant_created', this.record);
    return this.publicRecord();
  }

  clearAll(reason = 'cleared') {
    if (!this.record) return null;
    const cleared = this.record;
    this.record = null;
    this.emit('grant_revoked', cleared, { reason });
    return this.publicRecord(cleared);
  }

  snapshot() {
    return this.active();
  }
}
