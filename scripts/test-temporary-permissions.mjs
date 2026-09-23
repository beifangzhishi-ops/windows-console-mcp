import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TemporaryPermissionManager,
  TEMP_PERMISSION_DEFAULT_SECONDS,
} from '../router/temporary-permissions.mjs';
import {
  TEMP_PERMISSION_UI_HTML,
  TEMP_PERMISSION_UI_URI,
} from '../router/temporary-permission-app.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testStateRoot = path.join(rootDir, '.state');
fs.mkdirSync(testStateRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(testStateRoot, 'test-temp-perm-'));
const stateFile = path.join(tempRoot, 'permissions.json');
let now = Date.parse('2026-09-24T00:00:00.000Z');
const audit = [];

try {
  const manager = new TemporaryPermissionManager({
    stateFile,
    now: () => now,
    audit: (event) => audit.push(event),
  });

  assert.equal(TEMP_PERMISSION_DEFAULT_SECONDS, 21600);
  const prepared = manager.request({
    deviceId: 'device-a',
    justification: 'Test temporary access.',
  });
  assert.equal(prepared.request.state, 'pending');
  assert.equal(prepared.request.device_id, 'device-a');
  assert.equal(prepared.request.requested_duration_seconds, 21600);
  assert.ok(prepared.request.approval_id);
  assert.ok(prepared.approvalNonce);
  assert.throws(() => manager.resolve({
    approvalId: prepared.request.approval_id,
    approvalNonce: 'wrong',
    decision: 'approve',
  }), /Invalid approval token/);

  now += 60_000;
  const approved = manager.resolve({
    approvalId: prepared.request.approval_id,
    approvalNonce: prepared.approvalNonce,
    decision: 'approve',
  });
  assert.equal(approved.state, 'approved');
  assert.match(approved.permission_id, /^wcm_perm_/);
  assert.equal(
    Date.parse(approved.expires_at) - Date.parse(approved.issued_at),
    6 * 60 * 60 * 1000,
  );
  assert.throws(() => manager.resolve({
    approvalId: prepared.request.approval_id,
    approvalNonce: prepared.approvalNonce,
    decision: 'approve',
  }), /Unknown or expired approval_id/);

  const stateText = fs.readFileSync(stateFile, 'utf8');
  assert.doesNotMatch(stateText, new RegExp(approved.permission_id));
  assert.match(stateText, /permissionHash/);

  const active = manager.validate({
    permissionId: approved.permission_id,
    deviceId: 'device-a',
  });
  assert.equal(active.ok, true);
  assert.equal(active.state, 'active');
  assert.equal(manager.validate({
    permissionId: approved.permission_id,
    deviceId: 'device-b',
  }).ok, false);

  const reloaded = new TemporaryPermissionManager({
    stateFile,
    now: () => now,
  });
  assert.equal(reloaded.validate({
    permissionId: approved.permission_id,
    deviceId: 'device-a',
  }).ok, true);

  now = Date.parse(approved.expires_at) - 1;
  assert.equal(reloaded.validate({
    permissionId: approved.permission_id,
    deviceId: 'device-a',
  }).ok, true);
  now += 1;
  const expired = reloaded.validate({
    permissionId: approved.permission_id,
    deviceId: 'device-a',
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.state, 'expired');

  now = Date.parse('2026-09-24T07:00:00.000Z');
  const second = manager.request({ deviceId: 'device-a' });
  const secondApproved = manager.resolve({
    approvalId: second.request.approval_id,
    approvalNonce: second.approvalNonce,
    decision: 'approve',
  });
  assert.equal(manager.revoke({
    permissionId: secondApproved.permission_id,
    deviceId: 'device-a',
  }).state, 'revoked');
  const revokedStatus = manager.validate({
    permissionId: secondApproved.permission_id,
    deviceId: 'device-a',
  });
  assert.equal(revokedStatus.ok, false);
  assert.equal(revokedStatus.state, 'revoked');
  assert.equal(manager.status({
    permissionId: secondApproved.permission_id,
    deviceId: 'device-a',
  }).state, 'revoked');

  const denied = manager.request({ deviceId: 'device-a' });
  assert.equal(manager.resolve({
    approvalId: denied.request.approval_id,
    approvalNonce: denied.approvalNonce,
    decision: 'deny',
  }).state, 'denied');

  const expiring = manager.request({ deviceId: 'device-a' });
  now = Date.parse(expiring.request.approval_expires_at);
  assert.throws(() => manager.resolve({
    approvalId: expiring.request.approval_id,
    approvalNonce: expiring.approvalNonce,
    decision: 'approve',
  }), /Unknown or expired approval_id/);

  fs.writeFileSync(stateFile, '{not-json', 'utf8');
  const failClosed = new TemporaryPermissionManager({ stateFile, now: () => now });
  assert.equal(failClosed.validate({
    permissionId: secondApproved.permission_id,
    deviceId: 'device-a',
  }).ok, false);

  assert.equal(TEMP_PERMISSION_UI_URI, 'ui://wcm/temporary-permission-v1.html');
  assert.match(TEMP_PERMISSION_UI_HTML, /Approve for/);
  assert.match(TEMP_PERMISSION_UI_HTML, /approval_nonce/);
  assert.match(TEMP_PERMISSION_UI_HTML, /resolve_temporary_permission/);
  assert.match(TEMP_PERMISSION_UI_HTML, /ui\/update-model-context/);
  assert.ok(audit.some((event) => event.event === 'permission_requested'));
  assert.ok(audit.some((event) => event.event === 'permission_approved'));
  assert.ok(audit.every((event) => !JSON.stringify(event).includes('wcm_perm_')));

  console.log('WCM temporary permission tests: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
