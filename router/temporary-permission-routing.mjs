import {
  TEMP_PERMISSION_UI_HTML,
  TEMP_PERMISSION_UI_URI,
} from './temporary-permission-app.mjs';

export function temporaryPermissionSchema() {
  return {
    type: 'string',
    minLength: 1,
    description: 'Temporary WCM permission for this exact device. Obtain it with request_temporary_permission.',
  };
}

function temporaryPermissionOutputSchema() {
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
      justification: { type: 'string' },
      requested_duration_seconds: { type: 'number' },
      approval_expires_at: { type: 'string' },
      expires_at: { type: 'string' },
      intent_sha256: { type: 'string' },
      permission_id: { type: 'string' },
      issued_at: { type: 'string' },
      error: { type: 'string' },
    },
    additionalProperties: true,
  };
}

export function withTemporaryPermissionRoutingSchema(inputSchema, deviceSchema) {
  const schema = inputSchema && typeof inputSchema === 'object'
    ? structuredClone(inputSchema)
    : { type: 'object', properties: {} };
  schema.type = 'object';
  schema.properties = {
    ...(schema.properties || {}),
    deviceId: structuredClone(deviceSchema),
    permissionId: temporaryPermissionSchema(),
  };
  schema.required = Array.from(new Set([
    ...(schema.required || []),
    'deviceId',
    'permissionId',
  ]));
  return schema;
}

export function temporaryPermissionRouterTools(deviceSchema) {
  return [
    {
      name: 'request_temporary_permission',
      description: 'Request user approval for temporary access to one WCM device. Approval is completed in the WCM approval card; approved permissions last at most 6 hours.',
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
            description: 'Short user-facing reason for requesting access.',
          },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      outputSchema: temporaryPermissionOutputSchema(),
      _meta: {
        ui: { resourceUri: TEMP_PERMISSION_UI_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': TEMP_PERMISSION_UI_URI,
        'openai/outputTemplate': TEMP_PERMISSION_UI_URI,
        'openai/widgetAccessible': true,
      },
    },
    {
      name: 'resolve_temporary_permission',
      description: 'Resolve a pending WCM temporary-permission request. Intended for the WCM approval card; requires the hidden approval nonce.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
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
      outputSchema: temporaryPermissionOutputSchema(),
    },
    {
      name: 'temporary_permission_status',
      description: 'Check whether a WCM temporary permission is active for a specific device.',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: structuredClone(deviceSchema),
          permissionId: temporaryPermissionSchema(),
        },
        required: ['deviceId', 'permissionId'],
        additionalProperties: false,
      },
    },
    {
      name: 'revoke_temporary_permission',
      description: 'Immediately revoke a WCM temporary permission for a specific device.',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: structuredClone(deviceSchema),
          permissionId: temporaryPermissionSchema(),
        },
        required: ['deviceId', 'permissionId'],
        additionalProperties: false,
      },
    },
  ];
}

export function stripTemporaryPermissionRoutingArguments(args) {
  const forwarded = { ...(args || {}) };
  delete forwarded.deviceId;
  delete forwarded.permissionId;
  return forwarded;
}

export function temporaryPermissionResource() {
  return {
    uri: TEMP_PERMISSION_UI_URI,
    name: 'wcm-temporary-permission-ui',
    title: 'WCM temporary permission',
    description: 'Approval card for a six-hour WCM device permission.',
    mimeType: 'text/html;profile=mcp-app',
  };
}

export function localTemporaryPermissionResource(payload) {
  if (payload?.method !== 'resources/read' ||
      payload?.params?.uri !== TEMP_PERMISSION_UI_URI) {
    return null;
  }
  return {
    result: {
      contents: [{
        uri: TEMP_PERMISSION_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: TEMP_PERMISSION_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    },
  };
}

export function mergeTemporaryPermissionResourceList(message) {
  const result = message?.result && typeof message.result === 'object'
    ? structuredClone(message.result)
    : {};
  const resources = Array.isArray(result.resources) ? result.resources : [];
  if (!resources.some((resource) => resource?.uri === TEMP_PERMISSION_UI_URI)) {
    resources.unshift(temporaryPermissionResource());
  }
  return { result: { ...result, resources } };
}

export { TEMP_PERMISSION_UI_URI };
