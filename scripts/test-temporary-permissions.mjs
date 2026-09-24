import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TemporaryPermissionManager } from '../router/temporary-permissions.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testStateRoot = path.join(rootDir, '.state');
fs.mkdirSync(testStateRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(testStateRoot, 'test-temp-perm-'));
const stateFile = path.join(tempRoot, 'permissions.json');
let now = Date.parse('2026-09-24T00:00:00.000Z');
const audit = [];

function permissionHash(permissionId) {
  return crypto.createHash('sha256').update(permissionId).digest('hex');
}

function writeGrant(permissionId, {
  deviceId = 'device-a',
  issuedAt = now,
  expiresAt = issuedAt + (6 * 60 * 60 * 1000),
  revokedAt = null,
  expiredAt = null,
} = {}) {
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    grants: [{
      permissionHash: permissionHash(permissionId),
      deviceId,
      issuedAt,
      expiresAt,
      revokedAt,
      expiredAt,
    }],
  }, null, 2) + '\n', 'utf8');
}

try {
  const permissionId = 'wcm_perm_existing_test_capability';
  writeGrant(permissionId);
  const manager = new TemporaryPermissionManager({
    stateFile,
    now: () => now,
    audit: (event) => audit.push(event),
  });

  assert.equal(typeof manager.request, 'undefined');
  assert.equal(typeof manager.resolve, 'undefined');

  const active = manager.validate({ permissionId, deviceId: 'device-a' });
  assert.equal(active.ok, true);
  assert.equal(active.state, 'active');
  assert.equal(manager.validate({ permissionId, deviceId: 'device-b' }).ok, false);

  const stateText = fs.readFileSync(stateFile, 'utf8');
  assert.doesNotMatch(stateText, new RegExp(permissionId));
  assert.match(stateText, /permissionHash/);

  const reloaded = new TemporaryPermissionManager({ stateFile, now: () => now });
  assert.equal(reloaded.validate({ permissionId, deviceId: 'device-a' }).ok, true);

  now += 6 * 60 * 60 * 1000;
  const expired = reloaded.validate({ permissionId, deviceId: 'device-a' });
  assert.equal(expired.ok, false);
  assert.equal(expired.state, 'expired');

  now = Date.parse('2026-09-24T08:00:00.000Z');
  const revocable = 'wcm_perm_existing_revocable';
  writeGrant(revocable);
  const revokeManager = new TemporaryPermissionManager({ stateFile, now: () => now });
  assert.equal(revokeManager.revoke({
    permissionId: revocable,
    deviceId: 'device-a',
  }).state, 'revoked');
  assert.equal(revokeManager.status({
    permissionId: revocable,
    deviceId: 'device-a',
  }).state, 'revoked');

  fs.writeFileSync(stateFile, '{not-json', 'utf8');
  const failClosed = new TemporaryPermissionManager({ stateFile, now: () => now });
  assert.equal(failClosed.validate({
    permissionId: revocable,
    deviceId: 'device-a',
  }).ok, false);

  assert.ok(audit.some((event) => event.event === 'permission_used'));
  assert.ok(audit.every((event) => !JSON.stringify(event).includes(permissionId)));

  console.log('WCM temporary permission validation tests: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
