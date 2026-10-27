import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApprovalReceiptStore } from '../router/approval-receipt-store.mjs';
import { PendingActionManager } from '../router/pending-action-manager.mjs';
import { TimedGrantManager } from '../router/timed-grant-manager.mjs';

let now = Date.parse('2026-10-27T00:00:00Z');
const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-wcm-approval-receipts-'));
const stateFile = path.join(dir, 'private', 'receipts.json');
const createStore = () => new ApprovalReceiptStore({
  stateFile, now: () => now, retentionMs: 10_000, maxReceipts: 2,
});
try {
  const store = createStore();
  const manager = new PendingActionManager({
    now: () => now,
    onTerminal: (request, result) => store.save(request, result),
  });
  function prepare(action = 'get_config') {
    const request = manager.ensurePending({
      deviceId: '6v',
      toolName: action,
      workerArguments: { secret_command: 'do-not-persist' },
    }).request;
    const card = manager.prepareAppApproval(request.approval_id, {
      hostSession: 'session-a',
      requestedDurationSeconds: 60,
    });
    return { request, nonce: card.approvalNonce };
  }

  const denied = prepare();
  assert.equal(manager.readAppStatus(denied.request.approval_id, denied.nonce, 'session-a', store).state, 'pending');
  assert.throws(() => manager.readAppStatus(denied.request.approval_id, 'wrong-nonce', 'session-a', store), /nonce/u);
  assert.throws(() => manager.readAppStatus(denied.request.approval_id, denied.nonce, 'session-b', store), /different host session/u);
  manager.deny(denied.request.approval_id, denied.nonce, 'session-a');

  const consumed = prepare('start_process');
  manager.claim(consumed.request.approval_id, consumed.nonce, 'session-a');
  manager.markConsumed(consumed.request.approval_id, { actionFailed: true });

  const raw = fs.readFileSync(stateFile, 'utf8');
  assert.doesNotMatch(raw, /do-not-persist|secret_command|session-secret|workerArguments|grant_expires_at/u);
  assert.doesNotMatch(raw, new RegExp(denied.nonce, 'u'));
  assert.equal(JSON.parse(raw).receipts.length, 2);

  // New router process: only decision receipts remain; grants and pending actions do not.
  const restartedStore = createStore();
  const restartedManager = new PendingActionManager({
    now: () => now,
    onTerminal: (request, result) => restartedStore.save(request, result),
  });
  const historical = restartedManager.readAppStatus(
    consumed.request.approval_id, consumed.nonce, 'session-a', restartedStore,
  );
  assert.equal(historical.state, 'consumed');
  assert.equal(historical.action_failed, true);
  assert.equal(historical.result_unavailable, true);
  assert.throws(() => restartedManager.claim(consumed.request.approval_id, consumed.nonce, 'session-a'), /Unknown/u);
  assert.equal(new TimedGrantManager().active(consumed.request.approval_id), null);
  assert.throws(() => restartedManager.readAppStatus(consumed.request.approval_id, consumed.nonce, 'session-b', restartedStore), /invalid/u);
  assert.throws(() => restartedManager.readAppStatus(consumed.request.approval_id, denied.nonce, 'session-a', restartedStore), /invalid/u);

  now += 1;
  const unknown = prepare('read_file');
  manager.claim(unknown.request.approval_id, unknown.nonce, 'session-a');
  manager.markUnknown(unknown.request.approval_id);
  assert.equal(store.receipts.size, 2);
  assert.equal(store.read(denied.request.approval_id, denied.nonce, 'session-a'), null);
  assert.equal(createStore().read(unknown.request.approval_id, unknown.nonce, 'session-a').state, 'execution_unknown');
  now += 10_001;
  assert.equal(createStore().read(unknown.request.approval_id, unknown.nonce, 'session-a'), null);

  const expiring = prepare('read_file');
  now = Date.parse(manager.lookup(expiring.request.approval_id).card_expires_at) + 1;
  assert.equal(manager.readAppStatus(expiring.request.approval_id, expiring.nonce, 'session-a', store).state, 'expired');
  assert.equal(store.read(expiring.request.approval_id, expiring.nonce, 'session-a').state, 'expired');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('WCM nonce-bound, restart-safe receipt tests: PASS');
