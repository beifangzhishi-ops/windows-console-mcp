import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stdioUrl = pathToFileURL(path.join(
  workerRoot,
  'node_modules', '@wonderwhy-er', 'desktop-commander', 'dist', 'custom-stdio.js'
)).href;
const childCode = `
  import { FilteredStdioServerTransport } from ${JSON.stringify(stdioUrl)};
  new FilteredStdioServerTransport();
  const message = { jsonrpc: '2.0', id: 'oversize', result: { payload: 'x'.repeat(600000) } };
  process.stdout.write(JSON.stringify(message) + '\\n');
  setTimeout(() => process.exit(0), 10);
`;

const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childCode], {
  encoding: 'utf8',
  env: { ...process.env, DESKTOP_COMMANDER_MAX_STDOUT_JSON_BYTES: '65536' },
  timeout: 10000
});
assert.equal(result.status, 0, result.stderr || 'child failed');
const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
assert.equal(lines.length, 1, `unexpected stdout lines: ${lines.length}`);
const guarded = JSON.parse(lines[0]);assert.equal(guarded.id, 'oversize');
assert.equal(guarded.error?.code, -32099);
assert.match(guarded.error?.message || '', /blocked by safety limit/);
assert.ok(result.stdout.length < 2048, `guarded output still too large: ${result.stdout.length}`);
console.log('stdio guard smoke: ok');