import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { totpForCounter, WcmTotpManager } from '../router/totp.mjs';

const secret = Buffer.from('12345678901234567890', 'ascii');
assert.equal(totpForCounter(secret, 1), '287082'); // RFC 6238 SHA-1, 59 seconds
assert.equal(totpForCounter(secret, 37037036), '081804'); // RFC 6238, 1111111109 seconds

const dir = path.join(process.cwd(), '.state', 'test-artifacts', 'wcm-totp-' + process.pid);
fs.mkdirSync(dir, { recursive: true });
let time = 1_500_000;
const stateFile = path.join(dir, 'state.json');
const makeManager = (options = {}) => new WcmTotpManager({
  stateFile, secretProvider: () => secret, now: () => time, ...options,
});

try {
  const windowTime = 10_000_000;
  const currentWindow = Math.floor(windowTime / 30000);
  assert.equal(makeManager({
    stateFile: path.join(dir, 'window-oldest.json'), now: () => windowTime,
  }).verify(totpForCounter(secret, currentWindow - 10)), true,
  'a code generated approximately five minutes earlier must be accepted');
  assert.equal(makeManager({
    stateFile: path.join(dir, 'window-too-old.json'), now: () => windowTime,
  }).verify(totpForCounter(secret, currentWindow - 11)), false,
  'codes beyond the lookback must be rejected');
  assert.equal(makeManager({
    stateFile: path.join(dir, 'window-future.json'), now: () => windowTime,
  }).verify(totpForCounter(secret, currentWindow + 1)), true,
  'accept one future step for mild clock drift');
  const first = makeManager();
  const counter = Math.floor(time / 30000);
  assert.equal(first.verify(totpForCounter(secret, counter)), true);
  assert.equal(first.verify(totpForCounter(secret, counter)), false, 'replay must fail');
  assert.equal(makeManager().verify(totpForCounter(secret, counter)), false, 'replay must survive restart');
  time += 30000;
  assert.equal(makeManager().verify(totpForCounter(secret, counter + 1)), true);
  time += 30000;
  const wrong = makeManager();
  for (let i = 0; i < 5; i++) assert.equal(wrong.verify('not-valid'), false);
  assert.equal(wrong.verify(totpForCounter(secret, counter + 2)), false, 'lockout should reject valid code');
  time += 5 * 60000 + 1000;
  assert.equal(wrong.verify(totpForCounter(secret, Math.floor(time / 30000))), true);
  assert.equal(makeManager({ secretProvider: () => Buffer.alloc(20, 5) }).verify(
    totpForCounter(Buffer.alloc(20, 5), Math.floor(time / 30000))), true,
  'new phone secret starts an independent counter');
  assert.equal(makeManager().verify(totpForCounter(secret, Math.floor(time / 30000))), true,
    'old secret state resumes when paired secret changes in test');
  assert.ok(!fs.readFileSync(stateFile, 'utf8').includes(secret.toString('ascii')),
    'secret must not be written into replay file');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('WCM TOTP verification/replay/lockout tests: PASS');
