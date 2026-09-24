import assert from 'node:assert/strict';
import {
  APPROVAL_TEST_UI_HTML,
  APPROVAL_TEST_UI_URI,
} from '../router/approval-test-app.mjs';

const html = APPROVAL_TEST_UI_HTML;

assert.match(APPROVAL_TEST_UI_URI, /^ui:\/\/wcm\/approval-test\/[a-f0-9]{16}\.html$/u);
assert.match(html, /<div id="title">WCM approval<\/div>/);
assert.match(html, /<script>\s*\(\(\) => \{/);
assert.doesNotMatch(html, /type=["']module["']/i);
assert.doesNotMatch(html, /crossorigin/i);

for (const marker of [
  'const PROTOCOL_VERSION = "2026-01-26"',
  'window.parent.postMessage',
  'ui/initialize',
  'ui/notifications/initialized',
  'ui/notifications/tool-result',
  'tools/call',
  'resolve_approval_test',
  'ui/update-model-context',
  'window.openai?.toolResponseMetadata',
  'window.openai?.toolOutput',
  'openai:set_globals',
  'notifyIntrinsicHeight',
  'sendFollowUpMessage',
  'hidden.approval_nonce',
]) {
  assert.ok(html.includes(marker), `approval HTML is missing CCM parity marker: ${marker}`);
}

assert.doesNotMatch(html, /@modelcontextprotocol\/ext-apps/);
assert.doesNotMatch(html, /new App\(/);
assert.doesNotMatch(html, /app\.connect\(/);
assert.doesNotMatch(html, /callServerTool/);
assert.doesNotMatch(html, /CCM|ccm/);

const bodyIndex = html.indexOf('<body>');
const cardIndex = html.indexOf('id="card"');
const scriptIndex = html.indexOf('<script>');
assert.ok(bodyIndex >= 0 && cardIndex > bodyIndex);
assert.ok(scriptIndex > cardIndex, 'approval bridge must execute after the card DOM');
assert.equal((html.match(/<script>/g) || []).length, 1);

console.log('WCM CCM-parity approval View checks: PASS');
