import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bundlePath = path.resolve('ui', 'dist', 'approval-test.html');
assert.equal(fs.existsSync(bundlePath), true, 'approval-test bundle was not built');
const html = fs.readFileSync(bundlePath, 'utf8');
const source = fs.readFileSync(path.resolve('ui', 'approval-test', 'main.ts'), 'utf8');
assert.match(html, /WCM approval test/);
assert.match(html, /Loading MCP App/);
assert.ok(Buffer.byteLength(html, 'utf8') > 10000, 'bundle did not inline the MCP Apps SDK');
assert.match(source, /addEventListener\('toolresult'/);
assert.match(source, /app\.callServerTool/);
assert.match(source, /await app\.connect\(\)/);
assert.ok(
  source.indexOf("addEventListener('toolresult'") < source.indexOf('await app.connect()'),
  'toolresult listener must be registered before connect',
);
assert.doesNotMatch(source, /window\.openai/);
assert.doesNotMatch(source, /postMessage/);
console.log('WCM MCP App bundle checks: PASS');
