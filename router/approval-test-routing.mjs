import {
  APPROVAL_TEST_UI_HTML,
  APPROVAL_TEST_UI_URI,
} from './approval-test-app.mjs';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

function approvalTestOutputSchema() {
  return {
    type: 'object',
    properties: {
      approval_required: { type: 'boolean' },
      approval_id: { type: 'string' },
      operation_id: { type: 'string' },
      state: {
        type: 'string',
        enum: ['pending', 'dispatching', 'approved_retryable', 'execution_unknown', 'denied', 'consumed'],
      },
      device_id: { type: 'string' },
      command: { type: 'string' },
      shell: { type: ['string', 'null'] },
      timeout_ms: { type: 'number' },
      justification: { type: 'string' },
      expires_at: { type: 'string' },
      intent_sha256: { type: 'string' },
      action_failed: { type: 'boolean' },
      output: { type: 'string' },
    },
    additionalProperties: true,
  };
}

export function approvalTestRouterTools(deviceSchema) {
  return [
    {
      name: 'approval_test_exec',
      description: [
        'Test-only WCM execution path for validating the approval card.',
        'This initial call does not execute anything. WCM freezes one fixed read-only hostname test for the selected device, returns approval_required=true, and then the model must call request_approval_test with the returned approval_id.',
        'Only this test tool uses the test approval flow; ordinary WCM tools are unaffected.',
      ].join('\n\n'),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: structuredClone(deviceSchema),
          justification: {
            type: 'string',
            description: 'Short user-facing reason shown in the approval test card.',
          },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      outputSchema: approvalTestOutputSchema(),
    },
    {
      name: 'request_approval_test',
      description: [
        'Render the WCM approval test card for one already-frozen approval_test_exec action.',
        'Pass only the approval_id returned by approval_test_exec with approval_required=true. This tool cannot replace the frozen device or command.',
      ].join('\n\n'),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: APPROVAL_TEST_UI_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': APPROVAL_TEST_UI_URI,
        'openai/outputTemplate': APPROVAL_TEST_UI_URI,
        'openai/widgetAccessible': true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', format: 'uuid' },
        },
        required: ['approval_id'],
        additionalProperties: false,
      },
      outputSchema: approvalTestOutputSchema(),
    },
    {
      name: 'resolve_approval_test',
      description: 'App-only resolver for one frozen WCM approval test command.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      _meta: {
        ui: { visibility: ['app'] },
        'openai/widgetAccessible': true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', format: 'uuid' },
          approval_nonce: { type: 'string', minLength: 20 },
          decision: { type: 'string', enum: ['approve', 'deny'] },
        },
        required: ['approval_id', 'approval_nonce', 'decision'],
        additionalProperties: false,
      },
      outputSchema: approvalTestOutputSchema(),
    },
  ];
}

export function approvalTestResource() {
  return {
    uri: APPROVAL_TEST_UI_URI,
    name: 'wcm-approval-test-ui',
    title: 'WCM approval test',
    description: 'Test card for one frozen WCM command.',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { prefersBorder: true } },
  };
}

export function localApprovalTestResource(payload) {
  if (payload?.method !== 'resources/read' || payload?.params?.uri !== APPROVAL_TEST_UI_URI) {
    return null;
  }
  return {
    result: {
      contents: [{
        uri: APPROVAL_TEST_UI_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: APPROVAL_TEST_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    },
  };
}

export function mergeApprovalTestResourceList(message) {
  const result = message?.result && typeof message.result === 'object'
    ? structuredClone(message.result)
    : {};
  const resources = Array.isArray(result.resources) ? result.resources : [];
  if (!resources.some((resource) => resource?.uri === APPROVAL_TEST_UI_URI)) {
    resources.unshift(approvalTestResource());
  }
  return { result: { ...result, resources } };
}

export { APPROVAL_TEST_UI_URI };
