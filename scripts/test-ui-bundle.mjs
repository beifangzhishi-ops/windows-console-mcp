import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
} from '../router/approval-app.mjs';

const html = APPROVAL_UI_HTML;

assert.equal(APPROVAL_UI_URI, 'ui://wcm/approval-v1.html');
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
  'resolve_pending_action',
  'ui/update-model-context',
  'window.openai?.toolResponseMetadata',
  'window.openai?.toolOutput',
  'openai:set_globals',
  'notifyIntrinsicHeight',
  'sendFollowUpMessage',
  'hidden.approval_nonce',
  'card_expires_at',
  'Valid until',
  'approval_already_bound',
]) {
  assert.ok(html.includes(marker), `approval HTML is missing CCM-aligned marker: ${marker}`);
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

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/u);
assert.ok(scriptMatch?.[1], 'approval HTML must contain one inline script body');
assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'wcm-approval-inline.js' }));

console.log('WCM CCM-aligned approval View checks: PASS');
