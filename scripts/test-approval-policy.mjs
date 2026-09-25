import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ApprovalPolicyStore,
  DEFAULT_APPROVAL_DURATION_SECONDS,
  MAX_APPROVAL_DURATION_SECONDS,
  MIN_APPROVAL_DURATION_SECONDS,
  validateApprovalDurationSeconds,
} from '../router/approval-policy.mjs';

const scratch = path.join(process.cwd(), '.state', 'test-artifacts');
fs.mkdirSync(scratch, { recursive: true });
const root = path.join(scratch, 'approval-policy-' + process.pid);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const configDir = path.join(root, 'config');
const policyFile = path.join(configDir, 'approval-policy.json');
fs.mkdirSync(configDir, { recursive: true });

const warnings = [];
const store = new ApprovalPolicyStore({
  root,
  logger: { error: (value) => warnings.push(String(value)) },
});

let refreshed = store.refresh();
assert.deepEqual(refreshed.policy, { version: 1, mode: 'timed', revision: 0 });
assert.equal(refreshed.changed, false);
assert.equal(DEFAULT_APPROVAL_DURATION_SECONDS, 21600);
assert.equal(MIN_APPROVAL_DURATION_SECONDS, 60);
assert.equal(MAX_APPROVAL_DURATION_SECONDS, 604800);

fs.writeFileSync(policyFile, JSON.stringify({ version: 1, mode: 'off', revision: 1 }));
refreshed = store.refresh();
assert.equal(refreshed.changed, true);
assert.equal(refreshed.policy.mode, 'off');
assert.equal(refreshed.policy.revision, 1);

refreshed = store.refresh();
assert.equal(refreshed.changed, false);

fs.writeFileSync(policyFile, '{bad json');
refreshed = store.refresh();
assert.equal(refreshed.policy.mode, 'timed');
assert.equal(refreshed.policy.revision, 0);
assert.equal(refreshed.changed, true);
assert.equal(warnings.length, 1);

store.refresh();
assert.equal(warnings.length, 1, 'unchanged malformed policy must not spam warnings');

assert.equal(validateApprovalDurationSeconds(), 21600);
assert.equal(validateApprovalDurationSeconds(60), 60);
assert.equal(validateApprovalDurationSeconds(604800), 604800);
assert.throws(() => validateApprovalDurationSeconds(59), /between/u);
assert.throws(() => validateApprovalDurationSeconds(604801), /between/u);
assert.throws(() => validateApprovalDurationSeconds(2.5), /integer/u);

fs.rmSync(root, { recursive: true, force: true });
console.log('WCM approval policy tests: PASS');
