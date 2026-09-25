import assert from 'node:assert/strict';
import {
  DEFAULT_APPROVAL_DURATION_SECONDS,
  validateApprovalDurationSeconds,
} from '../router/approval-policy.mjs';
import { approvalFailureState } from '../router/approval-execution-state.mjs';
import {
  DEFAULT_BOUND_APPROVAL_TTL_MS,
  DEFAULT_TERMINAL_RETENTION_MS,
  DEFAULT_UNBOUND_APPROVAL_TTL_MS,
  PendingActionManager,
} from '../router/pending-action-manager.mjs';
import {
  DEFAULT_GRANT_TERMINAL_RETENTION_MS,
  TimedGrantManager,
} from '../router/timed-grant-manager.mjs';
import { APPROVAL_UI_HTML, APPROVAL_UI_URI } from '../router/approval-app.mjs';

let now = Date.parse('2026-09-25T00:00:00.000Z');
const audit = [];
const pendingManager = new PendingActionManager({
  now: () => now,
  audit: (event) => audit.push(event),
});
const grantManager = new TimedGrantManager({
  now: () => now,
  audit: (event) => audit.push(event),
});

const first = pendingManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'start_process',
  workerArguments: { command: 'hostname' },
  summary: 'start_process on device-a',
});
const second = pendingManager.ensurePending({
  deviceId: 'device-b',
  toolName: 'read_file',
  workerArguments: { path: 'C:\\x.txt' },
  summary: 'read_file on device-b',
});
assert.equal(first.owner, true);
assert.equal(second.owner, true);
assert.notEqual(second.request.approval_id, first.request.approval_id);
assert.equal(pendingManager.snapshot().pending_count, 2);
assert.equal(pendingManager.snapshot().pending_unbound_count, 2);

const firstUnboundExpiry = Date.parse(first.request.pending_expires_at);
assert.equal(firstUnboundExpiry - now, DEFAULT_UNBOUND_APPROVAL_TTL_MS);

const firstPrepared = pendingManager.prepareAppApproval(first.request.approval_id, {
  hostSession: 'host-a',
  requestedDurationSeconds: 120,
});
const secondPrepared = pendingManager.prepareAppApproval(second.request.approval_id, {
  hostSession: 'host-a',
  requestedDurationSeconds: 300,
});
assert.notEqual(firstPrepared.approvalNonce, secondPrepared.approvalNonce);
assert.equal(pendingManager.snapshot().pending_bound_count, 2);
assert.equal(
  Date.parse(firstPrepared.request.card_expires_at) - Date.parse(firstPrepared.request.card_bound_at),
  DEFAULT_BOUND_APPROVAL_TTL_MS,
);
assert.ok(Date.parse(firstPrepared.request.card_expires_at) > firstUnboundExpiry);

// Binding a card extends only that request past the original unbound deadline.
now = firstUnboundExpiry + 1;
assert.equal(pendingManager.lookup(first.request.approval_id).state, 'pending');
assert.equal(pendingManager.lookup(second.request.approval_id).state, 'pending');

// Denying one ID does not affect another.
const denied = pendingManager.deny(
  second.request.approval_id,
  secondPrepared.approvalNonce,
  'host-a',
);
assert.equal(denied.state, 'denied');
assert.equal(pendingManager.lookup(first.request.approval_id).state, 'pending');

const claimed = pendingManager.claim(
  first.request.approval_id,
  firstPrepared.approvalNonce,
  'host-a',
);
const grantA = grantManager.grant({
  approvalId: first.request.approval_id,
  requestedDurationSeconds: claimed.requestedDurationSeconds,
  operationId: first.request.operation_id,
  policyRevision: 3,
});
assert.equal(grantA.grant_state, 'active');
assert.equal(grantA.remaining_seconds, 120);
const consumed = pendingManager.markConsumed(first.request.approval_id);
assert.equal(consumed.state, 'consumed');
assert.equal(grantManager.active(first.request.approval_id).grant_state, 'active');
assert.throws(
  () => pendingManager.claim(first.request.approval_id, firstPrepared.approvalNonce, 'host-a'),
  /state=consumed/u,
);

// An active grant does not prevent minting or approving another independent ID.
const third = pendingManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const thirdPrepared = pendingManager.prepareAppApproval(third.request.approval_id, {
  hostSession: 'host-a',
  requestedDurationSeconds: 300,
});
const thirdClaimed = pendingManager.claim(
  third.request.approval_id,
  thirdPrepared.approvalNonce,
  'host-a',
);
const grantB = grantManager.grant({
  approvalId: third.request.approval_id,
  requestedDurationSeconds: thirdClaimed.requestedDurationSeconds,
  operationId: third.request.operation_id,
  policyRevision: 3,
});
pendingManager.markConsumed(third.request.approval_id);
assert.equal(grantB.grant_state, 'active');
assert.equal(grantManager.snapshot().grant_count, 2);
assert.ok(grantManager.active(first.request.approval_id));
assert.ok(grantManager.active(third.request.approval_id));

// Expiry is independent per approval_id.
now = Date.parse(grantA.expires_at);
assert.equal(grantManager.active(first.request.approval_id), null);
assert.equal(grantManager.inspect(first.request.approval_id).grant_state, 'expired');
assert.equal(grantManager.active(third.request.approval_id).grant_state, 'active');
assert.equal(grantManager.snapshot().grant_count, 1);

const revokedB = grantManager.clear(third.request.approval_id, 'test_revoke');
assert.equal(revokedB.grant_state, 'revoked');
assert.equal(grantManager.snapshot().grant_count, 0);

// Pending expiry is request-local.
const expiryManager = new PendingActionManager({ now: () => now });
const expiringUnbound = expiryManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'read_file',
  workerArguments: { path: 'C:\\unbound.txt' },
});
const boundSibling = expiryManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const boundSiblingPrepared = expiryManager.prepareAppApproval(boundSibling.request.approval_id, {
  requestedDurationSeconds: 60,
});
now = Date.parse(expiringUnbound.request.pending_expires_at);
assert.equal(expiryManager.lookup(expiringUnbound.request.approval_id).state, 'expired');
assert.equal(expiryManager.lookup(boundSibling.request.approval_id).state, 'pending');
now = Date.parse(boundSiblingPrepared.request.card_expires_at);
assert.equal(expiryManager.lookup(boundSibling.request.approval_id).state, 'expired');
assert.equal(
  expiryManager.lookup(boundSibling.request.approval_id).terminal_reason,
  'card_timeout',
);

// Policy invalidation supersedes every still-pending request.
const policyManager = new PendingActionManager({ now: () => now });
const policyA = policyManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const policyB = policyManager.ensurePending({
  deviceId: 'device-b',
  toolName: 'get_config',
  workerArguments: {},
});
const cleared = policyManager.clearPendingAll('policy_changed');
assert.equal(cleared.length, 2);
assert.equal(policyManager.lookup(policyA.request.approval_id).state, 'superseded');
assert.equal(policyManager.lookup(policyB.request.approval_id).state, 'superseded');

// Terminal request/grant tombstones are retained for six hours, then become unknown.
const retentionManager = new PendingActionManager({ now: () => now });
const retentionRequest = retentionManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const retentionPrepared = retentionManager.prepareAppApproval(retentionRequest.request.approval_id, {
  requestedDurationSeconds: 60,
});
retentionManager.deny(
  retentionRequest.request.approval_id,
  retentionPrepared.approvalNonce,
);
now += DEFAULT_TERMINAL_RETENTION_MS - 1;
assert.ok(retentionManager.lookup(retentionRequest.request.approval_id));
now += 1;
assert.equal(retentionManager.lookup(retentionRequest.request.approval_id), null);

const grantRetention = new TimedGrantManager({ now: () => now });
const retainedGrant = grantRetention.grant({
  approvalId: '00000000-0000-4000-8000-000000000001',
  requestedDurationSeconds: 60,
  operationId: 'operation-retention',
});
now = Date.parse(retainedGrant.expires_at);
assert.equal(grantRetention.inspect(retainedGrant.approval_id).grant_state, 'expired');
now += DEFAULT_GRANT_TERMINAL_RETENTION_MS - 1;
assert.ok(grantRetention.inspect(retainedGrant.approval_id));
now += 1;
assert.equal(grantRetention.inspect(retainedGrant.approval_id), null);

assert.equal(validateApprovalDurationSeconds(), DEFAULT_APPROVAL_DURATION_SECONDS);
assert.equal(validateApprovalDurationSeconds(120), 120);
assert.throws(() => validateApprovalDurationSeconds(59), /between 60 and 604800/u);
assert.throws(() => validateApprovalDurationSeconds(1.5), /integer/u);

assert.equal(
  approvalFailureState(new Error('Worker is offline: device-a')),
  'approved_retryable',
);
assert.equal(
  approvalFailureState(new Error('Worker request timed out: device-a')),
  'execution_unknown',
);
assert.equal(
  approvalFailureState(new Error('Worker disconnected: device-a')),
  'execution_unknown',
);
assert.equal(
  approvalFailureState(new Error('Worker connection replaced: device-a')),
  'execution_unknown',
);
assert.equal(
  approvalFailureState(new Error('write EPIPE')),
  'approved_retryable',
);

assert.equal(APPROVAL_UI_URI, 'ui://wcm/approval-v1.html');
assert.match(APPROVAL_UI_HTML, /<div id="title">WCM approval<\/div>/u);
assert.match(APPROVAL_UI_HTML, /full WCM|all routed WCM tools/u);
assert.match(APPROVAL_UI_HTML, /name: "resolve_pending_action"/u);
assert.match(APPROVAL_UI_HTML, /call_with_approval/u);
assert.ok(audit.some((event) => event.event === 'requested'));
assert.ok(audit.some((event) => event.event === 'app_bound'));
assert.ok(audit.some((event) => event.event === 'grant_created'));
assert.ok(audit.some((event) => event.event === 'grant_expired'));

console.log('WCM independent approval-id manager/app tests: PASS');
