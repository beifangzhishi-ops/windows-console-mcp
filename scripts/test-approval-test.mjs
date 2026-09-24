import assert from 'node:assert/strict';
import { ApprovalTestManager } from '../router/approval-test-manager.mjs';
import {
  APPROVAL_TEST_UI_HTML,
  APPROVAL_TEST_UI_URI,
} from '../router/approval-test-app.mjs';

let now = Date.parse('2026-09-24T00:00:00.000Z');
const audit = [];
const manager = new ApprovalTestManager({
  now: () => now,
  audit: (event) => audit.push(event),
});

const pending = manager.request({
  deviceId: 'device-a',
  command: 'printf APPROVAL_TEST_OK',
  shell: '/bin/sh',
  timeoutMs: 5000,
  justification: 'Test the WCM approval card.',
});

assert.equal(pending.state, 'pending');
assert.equal(pending.approval_required, true);
assert.equal(pending.device_id, 'device-a');
assert.equal(pending.command, 'printf APPROVAL_TEST_OK');
assert.ok(pending.approval_id);
assert.ok(pending.operation_id);
assert.match(pending.intent_sha256, /^[a-f0-9]{64}$/);

const prepared = manager.prepareAppApproval(pending.approval_id, {
  hostSession: 'host-a',
});
assert.equal(prepared.request.approval_id, pending.approval_id);
assert.ok(prepared.approvalNonce.length >= 20);
assert.throws(() => manager.prepareAppApproval(pending.approval_id), /already bound/);
assert.throws(() => manager.claim(
  pending.approval_id,
  'wrong',
  'host-a',
), /nonce is invalid/);
assert.throws(() => manager.claim(
  pending.approval_id,
  prepared.approvalNonce,
  'host-b',
), /different host session/);

const claimed = manager.claim(
  pending.approval_id,
  prepared.approvalNonce,
  'host-a',
);
assert.equal(claimed.request.state, 'dispatching');
assert.deepEqual(claimed.action, {
  deviceId: 'device-a',
  command: 'printf APPROVAL_TEST_OK',
  shell: '/bin/sh',
  timeoutMs: 5000,
});
const consumed = manager.markConsumed(pending.approval_id);
assert.equal(consumed.state, 'consumed');
assert.throws(() => manager.claim(
  pending.approval_id,
  prepared.approvalNonce,
  'host-a',
), /state=consumed/);

const denyPending = manager.request({ deviceId: 'device-a', command: 'echo NO' });
const denyPrepared = manager.prepareAppApproval(denyPending.approval_id, { hostSession: 'host-a' });
const denied = manager.deny(denyPending.approval_id, denyPrepared.approvalNonce, 'host-a');
assert.equal(denied.state, 'denied');

const expiring = manager.request({ deviceId: 'device-a', command: 'echo EXPIRE' });
now = Date.parse(expiring.expires_at);
assert.throws(() => manager.prepareAppApproval(expiring.approval_id), /Unknown or expired approval_id/);

assert.equal(APPROVAL_TEST_UI_URI, 'ui://wcm/approval-test-v1.html');
assert.match(APPROVAL_TEST_UI_HTML, /ui\/initialize/);
assert.match(APPROVAL_TEST_UI_HTML, /toolResponseMetadata/);
assert.match(APPROVAL_TEST_UI_HTML, /resolve_approval_test/);
assert.match(APPROVAL_TEST_UI_HTML, /ui\/update-model-context/);
assert.match(APPROVAL_TEST_UI_HTML, /sendFollowUpMessage/);
assert.ok(audit.some((event) => event.event === 'requested'));
assert.ok(audit.some((event) => event.event === 'app_bound'));
assert.ok(audit.some((event) => event.event === 'consumed'));

console.log('WCM approval test manager/app tests: PASS');
