import assert from 'node:assert/strict';
import {
  stripTemporaryPermissionRoutingArguments,
  temporaryPermissionRouterTools,
  withTemporaryPermissionRoutingSchema,
} from '../router/temporary-permission-routing.mjs';
import {
  APPROVAL_TEST_UI_URI,
  approvalTestRouterTools,
  localApprovalTestResource,
  mergeApprovalTestResourceList,
} from '../router/approval-test-routing.mjs';

const deviceSchema = {
  type: 'string',
  enum: ['device-a', 'device-b'],
  description: 'Target device.',
};

const routedSchema = withTemporaryPermissionRoutingSchema({
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
}, deviceSchema);
assert.deepEqual(routedSchema.required.sort(), ['deviceId', 'permissionId', 'value'].sort());
assert.deepEqual(routedSchema.properties.deviceId.enum, ['device-a', 'device-b']);
assert.equal(routedSchema.properties.permissionId.type, 'string');

const permissionTools = temporaryPermissionRouterTools(deviceSchema);
assert.deepEqual(permissionTools.map((tool) => tool.name).sort(), [
  'revoke_temporary_permission',
  'temporary_permission_status',
]);

const stripped = stripTemporaryPermissionRoutingArguments({
  deviceId: 'device-a',
  permissionId: 'wcm_perm_secret',
  value: 'forward-me',
});
assert.deepEqual(stripped, { value: 'forward-me' });

const approvalTools = approvalTestRouterTools(deviceSchema);
const testExec = approvalTools.find((tool) => tool.name === 'approval_test_exec');
const requestCard = approvalTools.find((tool) => tool.name === 'request_approval_test');
const resolver = approvalTools.find((tool) => tool.name === 'resolve_approval_test');
assert.ok(testExec && requestCard && resolver);
assert.equal(testExec._meta, undefined);
assert.deepEqual(testExec.inputSchema.required, ['deviceId', 'command']);
assert.deepEqual(requestCard.inputSchema.required, ['approval_id']);
assert.equal(requestCard._meta?.['openai/outputTemplate'], APPROVAL_TEST_UI_URI);
assert.equal(requestCard._meta?.['openai/widgetAccessible'], true);
assert.deepEqual(requestCard._meta?.ui?.visibility, ['model', 'app']);
assert.deepEqual(resolver._meta?.ui?.visibility, ['app']);
assert.equal(resolver._meta?.['openai/widgetAccessible'], true);
assert.equal(resolver.inputSchema.properties.approval_id.format, 'uuid');
assert.equal(resolver.inputSchema.properties.approval_nonce.minLength, 20);

const merged = mergeApprovalTestResourceList({
  result: {
    resources: [{
      uri: 'ui://worker/existing',
      name: 'existing',
      mimeType: 'text/html;profile=mcp-app',
    }],
  },
});
assert.ok(merged.result.resources.some((resource) => resource.uri === 'ui://worker/existing'));
assert.equal(
  merged.result.resources.filter((resource) => resource.uri === APPROVAL_TEST_UI_URI).length,
  1,
);

const localResource = localApprovalTestResource({
  method: 'resources/read',
  params: { uri: APPROVAL_TEST_UI_URI },
});
assert.equal(localResource?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
assert.match(localResource?.result?.contents?.[0]?.text || '', /WCM approval test/);
assert.equal(localResource?.result?.contents?.[0]?._meta?.ui?.prefersBorder, true);
assert.equal(localApprovalTestResource({
  method: 'resources/read',
  params: { uri: 'ui://worker/existing' },
}), null);

console.log('WCM router permission/test-approval contract: PASS');
