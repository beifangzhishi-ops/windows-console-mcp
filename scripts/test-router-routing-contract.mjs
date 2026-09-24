import assert from 'node:assert/strict';
import {
  stripDeviceRoutingArguments,
  withDeviceRoutingSchema,
} from '../router/device-routing.mjs';
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

const routedSchema = withDeviceRoutingSchema({
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
}, deviceSchema);
assert.deepEqual(routedSchema.required.sort(), ['deviceId', 'value'].sort());
assert.deepEqual(routedSchema.properties.deviceId.enum, ['device-a', 'device-b']);

const stripped = stripDeviceRoutingArguments({
  deviceId: 'device-a',
  value: 'forward-me',
});
assert.deepEqual(stripped, { value: 'forward-me' });

const approvalTools = approvalTestRouterTools(deviceSchema);
const testExec = approvalTools.find((tool) => tool.name === 'approval_test_exec');
const requestCard = approvalTools.find((tool) => tool.name === 'request_approval_test');
const resolver = approvalTools.find((tool) => tool.name === 'resolve_approval_test');
assert.ok(testExec && requestCard && resolver);
assert.equal(testExec._meta, undefined);
assert.deepEqual(testExec.inputSchema.required, ['deviceId']);
assert.equal(testExec.inputSchema.properties.command, undefined);
assert.deepEqual(requestCard.inputSchema.required, ['approval_id']);
assert.equal(requestCard._meta?.ui?.resourceUri, APPROVAL_TEST_UI_URI);
assert.deepEqual(requestCard._meta?.ui?.visibility, ['model', 'app']);
assert.equal(requestCard._meta?.['ui/resourceUri'], APPROVAL_TEST_UI_URI);
assert.equal(requestCard._meta?.['openai/outputTemplate'], APPROVAL_TEST_UI_URI);
assert.equal(requestCard._meta?.['openai/widgetAccessible'], true);
assert.equal(requestCard.execution?.taskSupport, 'forbidden');
assert.deepEqual(resolver._meta?.ui?.visibility, ['app']);
assert.equal(resolver._meta?.['openai/widgetAccessible'], true);
assert.equal(resolver.execution?.taskSupport, 'forbidden');
assert.equal(resolver.inputSchema.properties.approval_id.format, 'uuid');
assert.match(resolver.inputSchema.properties.approval_id.pattern, /0-9a-fA-F/u);
assert.equal(resolver.inputSchema.properties.approval_nonce.minLength, 20);
assert.equal(requestCard.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
assert.equal(resolver.inputSchema.$schema, 'http://json-schema.org/draft-07/schema#');
assert.equal(requestCard.inputSchema.additionalProperties, undefined);
assert.equal(resolver.inputSchema.additionalProperties, undefined);
assert.deepEqual(requestCard.outputSchema.required, ['wall_time_seconds', 'output']);
assert.equal(requestCard.outputSchema.additionalProperties, false);

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
const mergedApprovalResource = merged.result.resources.find(
  (resource) => resource.uri === APPROVAL_TEST_UI_URI,
);
assert.equal(mergedApprovalResource?._meta, undefined);

const localResource = localApprovalTestResource({
  method: 'resources/read',
  params: { uri: APPROVAL_TEST_UI_URI },
});
assert.equal(localResource?.result?.contents?.[0]?.mimeType, 'text/html;profile=mcp-app');
assert.match(localResource?.result?.contents?.[0]?.text || '', /<div id="title">WCM approval<\/div>/);
assert.equal(localResource?.result?.contents?.[0]?._meta?.ui?.prefersBorder, true);
assert.equal(localApprovalTestResource({
  method: 'resources/read',
  params: { uri: 'ui://worker/existing' },
}), null);

console.log('WCM router device/approval-test contract: PASS');
