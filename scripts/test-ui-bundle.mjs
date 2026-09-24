import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bundlePath = path.resolve('ui', 'dist', 'approval-test.html');
assert.equal(fs.existsSync(bundlePath), true, 'approval-test bundle was not built');
const html = fs.readFileSync(bundlePath, 'utf8');
const source = fs.readFileSync(path.resolve('ui', 'approval-test', 'main.ts'), 'utf8');

assert.match(html, /WCM approval test/);
assert.match(html, /Loading MCP App/);
assert.ok(Buffer.byteLength(html, 'utf8') > 3000, 'approval-test bundle is unexpectedly small');

assert.match(source, /window\.parent\.postMessage/);
assert.match(source, /ui\/initialize/);
assert.match(source, /ui\/notifications\/initialized/);
assert.match(source, /ui\/notifications\/tool-result/);
assert.match(source, /tools\/call/);
assert.match(source, /ui\/update-model-context/);
assert.match(source, /toolResponseMetadata/);
assert.match(source, /window\.openai\?\.toolOutput/);
assert.match(source, /openai:set_globals/);
assert.match(source, /notifyIntrinsicHeight/);
assert.match(source, /sendFollowUpMessage/);
assert.match(source, /hidden\.approval_nonce/);

assert.doesNotMatch(source, /import\s+\{\s*App\s*\}\s+from\s+['"]@modelcontextprotocol\/ext-apps['"]/);
assert.doesNotMatch(source, /new App\(/);
assert.doesNotMatch(source, /app\.connect\(/);
assert.doesNotMatch(source, /app\.callServerTool/);

console.log('WCM MCP App bridge bundle checks: PASS');
