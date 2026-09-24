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
  justification: 'Test the WCM approval card.',
});

assert.equal(pending.state, 'pending');
assert.equal(pending.approval_required, true);
assert.equal(pending.device_id, 'device-a');
assert.equal(pending.command, 'hostname');
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
  command: 'hostname',
  shell: null,
  timeoutMs: 30000,
});
const consumed = manager.markConsumed(pending.approval_id);
assert.equal(consumed.state, 'consumed');
assert.throws(() => manager.claim(
  pending.approval_id,
  prepared.approvalNonce,
  'host-a',
), /state=consumed/);

const denyPending = manager.request({ deviceId: 'device-a' });
const denyPrepared = manager.prepareAppApproval(denyPending.approval_id, { hostSession: 'host-a' });
const denied = manager.deny(denyPending.approval_id, denyPrepared.approvalNonce, 'host-a');
assert.equal(denied.state, 'denied');

const expiring = manager.request({ deviceId: 'device-a' });
now = Date.parse(expiring.expires_at);
assert.throws(() => manager.prepareAppApproval(expiring.approval_id), /Unknown or expired approval_id/);

assert.match(APPROVAL_TEST_UI_URI, /^ui:\/\/wcm\/approval-test\/[a-f0-9]{16}\.html$/u);
assert.match(APPROVAL_TEST_UI_HTML, /<div id="title">WCM approval<\/div>/);
assert.match(APPROVAL_TEST_UI_HTML, /const PROTOCOL_VERSION = "2026-01-26"/);
assert.match(APPROVAL_TEST_UI_HTML, /window\.openai\?\.toolResponseMetadata/);
assert.match(APPROVAL_TEST_UI_HTML, /name: "resolve_approval_test"/);
assert.ok(audit.some((event) => event.event === 'requested'));
assert.ok(audit.some((event) => event.event === 'app_bound'));
assert.ok(audit.some((event) => event.event === 'consumed'));

console.log('WCM approval test manager/app tests: PASS');
