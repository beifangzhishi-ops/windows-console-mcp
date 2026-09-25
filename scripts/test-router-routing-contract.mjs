import assert from 'node:assert/strict';
import {
  stripDeviceRoutingArguments,
  withDeviceRoutingSchema,
} from '../router/device-routing.mjs';
import {
  APPROVAL_UI_URI,
  approvalRouterTools,
  localApprovalResource,
} from '../router/approval-routing.mjs';

const deviceSchema = {
  type: 'string',
  enum: ['device-a', 'device-b'],
  description: 'Target device.',
};

const routedSchema = withDeviceRoutingSchema({
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
}, deviceSchema);
assert.deepEqual(routedSchema.required.sort(), ['deviceId', 'value'].sort());
assert.deepEqual(routedSchema.properties.deviceId.enum, ['device-a', 'device-b']);
assert.deepEqual(stripDeviceRoutingArguments({
  deviceId: 'device-a',
  value: 'forward-me',
}), { value: 'forward-me' });

const approvalTools = approvalRouterTools();
const statusTool = approvalTools.find((tool) => tool.name === 'approval_status');
const callWithApproval = approvalTools.find((tool) => tool.name === 'call_with_approval');
const requestCard = approvalTools.find((tool) => tool.name === 'request_approval');
const resolver = approvalTools.find((tool) => tool.name === 'resolve_pending_action');
assert.ok(statusTool && callWithApproval && requestCard && resolver);
assert.deepEqual(statusTool.inputSchema.required, ['approval_id']);
assert.deepEqual(
  callWithApproval.inputSchema.required.sort(),
  ['approval_id', 'deviceId', 'tool_name'].sort(),
);
assert.equal(callWithApproval.inputSchema.properties.arguments.type, 'object');
assert.deepEqual(requestCard.inputSchema.required, ['approval_id']);
assert.equal(requestCard.inputSchema.properties.duration_seconds.default, 21600);
assert.equal(requestCard.inputSchema.properties.duration_seconds.minimum, 60);
assert.equal(requestCard.inputSchema.properties.duration_seconds.maximum, 604800);
assert.equal(requestCard._meta?.ui?.resourceUri, APPROVAL_UI_URI);
assert.deepEqual(requestCard._meta?.ui?.visibility, ['model', 'app']);
assert.equal(requestCard._meta?.['openai/outputTemplate'], APPROVAL_UI_URI);
assert.equal(requestCard._meta?.['openai/widgetAccessible'], true);
assert.deepEqual(resolver._meta?.ui?.visibility, ['app']);
assert.equal(resolver.inputSchema.properties.approval_nonce.minLength, 20);
assert.equal(resolver.inputSchema.properties.duration_seconds, undefined);
for (const field of [
  'created_at',
  'card_bound_at',
  'card_expires_at',
  'pending_expires_at',
  'terminal_reason',
  'grant_state',
  'usable',
]) {
  assert.ok(requestCard.outputSchema.properties[field], `approval output is missing ${field}`);
}

const listed = localApprovalResource({ method: 'resources/list', params: {} });
assert.deepEqual(listed.result.resources.map((item) => item.uri), [APPROVAL_UI_URI]);
const templates = localApprovalResource({ method: 'resources/templates/list', params: {} });
assert.deepEqual(templates.result.resourceTemplates, []);
const local = localApprovalResource({
  method: 'resources/read',
  params: { uri: APPROVAL_UI_URI },
});
assert.equal(local.result.contents[0].mimeType, 'text/html;profile=mcp-app');
assert.equal(local.result.contents[0]._meta.ui.prefersBorder, true);
const missing = localApprovalResource({
  method: 'resources/read',
  params: { uri: 'ui://worker/existing' },
});
assert.equal(missing.error.code, -32002);

console.log('WCM router device/timed-approval contract: PASS');
