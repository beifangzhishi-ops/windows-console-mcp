import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_DC_RESPONSE_BYTES,
  guardDesktopCommanderMessage,
  resolveMaxDcResponseBytes,
  shouldGuardDesktopCommanderResponse
} from '../response-guard.mjs';

assert.equal(resolveMaxDcResponseBytes(undefined), DEFAULT_MAX_DC_RESPONSE_BYTES);
assert.equal(resolveMaxDcResponseBytes('1048576'), 1048576);
assert.equal(resolveMaxDcResponseBytes('1'), DEFAULT_MAX_DC_RESPONSE_BYTES);
assert.equal(shouldGuardDesktopCommanderResponse('tools/call'), true);
assert.equal(shouldGuardDesktopCommanderResponse('resources/read'), false);

const original = { jsonrpc: '2.0', id: 'abc', result: { content: 'ok' } };
assert.equal(guardDesktopCommanderMessage(original, 100, 1000), original);

const blocked = guardDesktopCommanderMessage(original, 2000, 1000);
assert.equal(blocked.id, 'abc');
assert.equal(blocked.error.code, -32099);
assert.match(blocked.error.message, /blocked by worker safety limit/);
assert.equal(blocked.result, undefined);

console.log('response guard smoke: ok');