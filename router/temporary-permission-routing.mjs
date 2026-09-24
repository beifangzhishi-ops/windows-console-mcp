export function temporaryPermissionSchema() {
  return {
    type: 'string',
    minLength: 1,
    description: 'Existing active WCM temporary permission for this exact device. New permission issuance is currently disabled.',
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
      name: 'temporary_permission_status',
      description: 'Check whether an existing WCM temporary permission is active for a specific device.',
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
      description: 'Immediately revoke an existing WCM temporary permission for a specific device.',
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
