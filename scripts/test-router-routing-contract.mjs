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
import { RESTART_WCM_TOOL } from '../router/self-restart.mjs';

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
assert.equal(routedSchema.properties.approval_id.type, 'string');
assert.equal(routedSchema.properties.approval_id.format, 'uuid');
assert.equal(routedSchema.required.includes('approval_id'), false);
assert.deepEqual(stripDeviceRoutingArguments({
  deviceId: 'device-a',
  approval_id: '00000000-0000-4000-8000-000000000001',
  value: 'forward-me',
}), { value: 'forward-me' });

const approvalTools = approvalRouterTools();
const unlockTool = approvalTools.find((tool) => tool.name === 'wcm_unlock');
assert.deepEqual(unlockTool.inputSchema.required, ['code']);
assert.equal(unlockTool.inputSchema.properties.code.pattern, '^[0-9]{6}$');
assert.equal(unlockTool.inputSchema.properties.duration_seconds.default, 21600);
assert.equal(RESTART_WCM_TOOL.name, 'restart_wcm');
assert.deepEqual(RESTART_WCM_TOOL.inputSchema.required, undefined);
assert.deepEqual(RESTART_WCM_TOOL.inputSchema.properties, {});
assert.equal(RESTART_WCM_TOOL.inputSchema.additionalProperties, false);
const statusTool = approvalTools.find((tool) => tool.name === 'approval_status');
const verifiedStatus = approvalTools.find((tool) => tool.name === 'get_approval_status');
const requestCard = approvalTools.find((tool) => tool.name === 'request_approval');
const resolver = approvalTools.find((tool) => tool.name === 'resolve_pending_action');
assert.ok(statusTool && verifiedStatus && requestCard && resolver);
assert.deepEqual(
  approvalTools.map((tool) => tool.name),
  ['wcm_unlock', 'approval_status', 'get_approval_status', 'request_approval', 'resolve_pending_action'],
);
assert.deepEqual(statusTool.inputSchema.required, ['approval_id']);
assert.deepEqual(verifiedStatus.inputSchema.required, ['approval_id', 'approval_nonce']);
assert.deepEqual(verifiedStatus._meta?.ui?.visibility, ['app']);
assert.equal(verifiedStatus.annotations.readOnlyHint, true);
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
