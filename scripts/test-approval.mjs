import assert from 'node:assert/strict';
import {
  DEFAULT_APPROVAL_DURATION_SECONDS,
  validateApprovalDurationSeconds,
} from '../router/approval-policy.mjs';
import { approvalFailureState } from '../router/approval-execution-state.mjs';
import {
  DEFAULT_BOUND_APPROVAL_TTL_MS,
  DEFAULT_UNBOUND_APPROVAL_TTL_MS,
  PendingActionManager,
} from '../router/pending-action-manager.mjs';
import { TimedGrantManager } from '../router/timed-grant-manager.mjs';
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
assert.equal(first.owner, true);
assert.equal(first.request.state, 'pending');
assert.equal(first.request.approval_required, true);
assert.match(first.request.intent_sha256, /^[a-f0-9]{64}$/u);
assert.ok(first.request.created_at);
assert.equal(first.request.card_bound_at, null);
assert.equal(first.request.card_expires_at, null);
const firstUnboundExpiry = Date.parse(first.request.pending_expires_at);
assert.equal(firstUnboundExpiry - now, DEFAULT_UNBOUND_APPROVAL_TTL_MS);

const concurrent = pendingManager.ensurePending({
  deviceId: 'device-b',
  toolName: 'read_file',
  workerArguments: { path: 'C:\\x.txt' },
});
assert.equal(concurrent.owner, false);
assert.equal(concurrent.queued, false);
assert.equal(concurrent.request.approval_id, first.request.approval_id);

const prepared = pendingManager.prepareAppApproval(first.request.approval_id, {
  hostSession: 'host-a',
  requestedDurationSeconds: 7200,
});
assert.equal(prepared.request.requested_duration_seconds, 7200);
assert.ok(prepared.approvalNonce.length >= 20);
assert.ok(prepared.request.card_bound_at);
assert.ok(prepared.request.card_expires_at);
assert.equal(
  Date.parse(prepared.request.card_expires_at) - Date.parse(prepared.request.card_bound_at),
  DEFAULT_BOUND_APPROVAL_TTL_MS,
);
assert.equal(prepared.request.pending_expires_at, prepared.request.card_expires_at);
assert.ok(Date.parse(prepared.request.pending_expires_at) > firstUnboundExpiry);
assert.throws(
  () => pendingManager.prepareAppApproval(first.request.approval_id, {
    hostSession: 'host-a',
    requestedDurationSeconds: 3600,
  }),
  /duration is already frozen|already bound/u,
);
assert.throws(
  () => pendingManager.claim(first.request.approval_id, 'wrong', 'host-a'),
  /nonce is invalid/u,
);
assert.throws(
  () => pendingManager.claim(first.request.approval_id, prepared.approvalNonce, 'host-b'),
  /different host session/u,
);

now = firstUnboundExpiry + 1;
const claimed = pendingManager.claim(
  first.request.approval_id,
  prepared.approvalNonce,
  'host-a',
);
assert.equal(claimed.request.state, 'dispatching');
assert.equal(claimed.requestedDurationSeconds, 7200);
assert.deepEqual(claimed.action.workerArguments, { command: 'hostname' });

const grant = grantManager.grant({
  approvalId: first.request.approval_id,
  requestedDurationSeconds: claimed.requestedDurationSeconds,
  operationId: first.request.operation_id,
  policyRevision: 3,
});
assert.equal(grant.remaining_seconds, 7200);
assert.equal(grant.policy_revision, 3);

const consumed = pendingManager.markConsumed(first.request.approval_id);
assert.equal(consumed.state, 'consumed');
assert.throws(
  () => pendingManager.claim(first.request.approval_id, prepared.approvalNonce, 'host-a'),
  /state=consumed/u,
);

now += 7200 * 1000;
assert.equal(grantManager.active(), null);

const deniedOwner = pendingManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const denyPrepared = pendingManager.prepareAppApproval(deniedOwner.request.approval_id, {
  hostSession: 'host-a',
  requestedDurationSeconds: DEFAULT_APPROVAL_DURATION_SECONDS,
});
const denied = pendingManager.deny(
  deniedOwner.request.approval_id,
  denyPrepared.approvalNonce,
  'host-a',
);
assert.equal(denied.state, 'denied');

const expiring = pendingManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'read_file',
  workerArguments: { path: 'C:\\x.txt' },
});
now = Date.parse(expiring.request.pending_expires_at);
const expired = pendingManager.lookup(expiring.request.approval_id);
assert.equal(expired.state, 'expired');
assert.equal(expired.terminal_reason, 'unbound_timeout');
assert.throws(
  () => pendingManager.prepareAppApproval(expiring.request.approval_id, {
    requestedDurationSeconds: 60,
  }),
  /state=expired/u,
);

const boundExpiryManager = new PendingActionManager({
  now: () => now,
  audit: (event) => audit.push(event),
});
const boundExpiryOwner = boundExpiryManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
const boundExpiryPrepared = boundExpiryManager.prepareAppApproval(
  boundExpiryOwner.request.approval_id,
  {
    hostSession: 'host-a',
    requestedDurationSeconds: 60,
  },
);
const frozenCardExpiry = boundExpiryPrepared.request.card_expires_at;
assert.throws(
  () => boundExpiryManager.prepareAppApproval(boundExpiryOwner.request.approval_id, {
    hostSession: 'host-a',
    requestedDurationSeconds: 60,
  }),
  /already bound/u,
);
const stillBound = boundExpiryManager.lookup(boundExpiryOwner.request.approval_id);
assert.equal(stillBound.requested_duration_seconds, 60);
assert.equal(stillBound.card_expires_at, frozenCardExpiry);
now = Date.parse(frozenCardExpiry);
const boundExpired = boundExpiryManager.lookup(boundExpiryOwner.request.approval_id);
assert.equal(boundExpired.state, 'expired');
assert.equal(boundExpired.terminal_reason, 'card_timeout');
assert.throws(
  () => boundExpiryManager.deny(
    boundExpiryOwner.request.approval_id,
    boundExpiryPrepared.approvalNonce,
    'host-a',
  ),
  /state=expired/u,
);

const supersedeManager = new PendingActionManager({ now: () => now });
const supersededOwner = supersedeManager.ensurePending({
  deviceId: 'device-a',
  toolName: 'get_config',
  workerArguments: {},
});
supersedeManager.prepareAppApproval(supersededOwner.request.approval_id, {
  requestedDurationSeconds: 60,
});
const superseded = supersedeManager.clearPending('policy_changed');
assert.equal(superseded.state, 'superseded');
assert.equal(superseded.terminal_reason, 'policy_changed');

assert.equal(validateApprovalDurationSeconds(), 21600);
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
assert.ok(audit.some((event) => event.event === 'requested'));
assert.ok(audit.some((event) => event.event === 'app_bound'));
assert.ok(audit.some((event) => event.event === 'grant_created'));
assert.ok(audit.some((event) => event.event === 'grant_expired'));
assert.ok(audit.some((event) => event.event === 'expired' && event.terminal_reason === 'card_timeout'));

console.log('WCM timed approval manager/app tests: PASS');
