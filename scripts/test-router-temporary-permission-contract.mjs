import assert from 'node:assert/strict';
import {
  TEMP_PERMISSION_UI_URI,
  localTemporaryPermissionResource,
  mergeTemporaryPermissionResourceList,
  stripTemporaryPermissionRoutingArguments,
  temporaryPermissionRouterTools,
  withTemporaryPermissionRoutingSchema,
} from '../router/temporary-permission-routing.mjs';

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
assert.deepEqual(
  routedSchema.required.sort(),
  ['deviceId', 'permissionId', 'value'].sort(),
);
assert.deepEqual(routedSchema.properties.deviceId.enum, ['device-a', 'device-b']);
assert.equal(routedSchema.properties.permissionId.type, 'string');

const routerTools = temporaryPermissionRouterTools(deviceSchema);
const requestTool = routerTools.find((tool) => tool.name === 'request_temporary_permission');
const resolveTool = routerTools.find((tool) => tool.name === 'resolve_temporary_permission');
const statusTool = routerTools.find((tool) => tool.name === 'temporary_permission_status');
const revokeTool = routerTools.find((tool) => tool.name === 'revoke_temporary_permission');
assert.ok(requestTool && resolveTool && statusTool && revokeTool);
assert.deepEqual(requestTool.inputSchema.required, ['deviceId']);
assert.equal(requestTool._meta?.['openai/outputTemplate'], TEMP_PERMISSION_UI_URI);
assert.equal(requestTool._meta?.['openai/widgetAccessible'], true);
assert.deepEqual(requestTool._meta?.ui?.visibility, ['model', 'app']);
assert.ok(requestTool.outputSchema?.properties?.operation_id);
assert.ok(resolveTool.inputSchema.required.includes('approval_nonce'));
assert.deepEqual(resolveTool._meta?.ui?.visibility, ['app']);
assert.equal(resolveTool._meta?.['openai/widgetAccessible'], true);
assert.equal(resolveTool.inputSchema.properties.approval_id.format, 'uuid');
assert.equal(resolveTool.inputSchema.properties.approval_nonce.minLength, 20);
assert.ok(resolveTool.outputSchema?.properties?.permission_id);
assert.deepEqual(statusTool.inputSchema.required.sort(), ['deviceId', 'permissionId'].sort());
assert.deepEqual(revokeTool.inputSchema.required.sort(), ['deviceId', 'permissionId'].sort());

const stripped = stripTemporaryPermissionRoutingArguments({
  deviceId: 'device-a',
  permissionId: 'wcm_perm_secret',
  value: 'forward-me',
});
assert.deepEqual(stripped, { value: 'forward-me' });

const merged = mergeTemporaryPermissionResourceList({
  result: {
    resources: [{
      uri: 'ui://worker/existing',
      name: 'existing',
      mimeType: 'text/html;profile=mcp-app',
    }],
  },
});
assert.ok(merged.result.resources.some((resource) => resource.uri === 'ui://worker/existing'));
assert.ok(merged.result.resources.some((resource) => resource.uri === TEMP_PERMISSION_UI_URI));
assert.equal(
  merged.result.resources.filter((resource) => resource.uri === TEMP_PERMISSION_UI_URI).length,
  1,
);
const mergedAgain = mergeTemporaryPermissionResourceList(merged);
assert.equal(
  mergedAgain.result.resources.filter((resource) => resource.uri === TEMP_PERMISSION_UI_URI).length,
  1,
);

const localResource = localTemporaryPermissionResource({
  method: 'resources/read',
  params: { uri: TEMP_PERMISSION_UI_URI },
});
assert.equal(localResource?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
assert.match(localResource?.result?.contents?.[0]?.text || '', /WCM temporary permission/);
assert.equal(localResource?.result?.contents?.[0]?._meta?.ui?.prefersBorder, true);
assert.equal(localTemporaryPermissionResource({
  method: 'resources/read',
  params: { uri: 'ui://worker/existing' },
}), null);

console.log('WCM router temporary permission contract: PASS');
