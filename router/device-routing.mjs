export function withDeviceRoutingSchema(inputSchema, deviceSchema) {
  const schema = inputSchema && typeof inputSchema === 'object'
    ? structuredClone(inputSchema)
    : { type: 'object', properties: {} };
  schema.type = 'object';
  schema.properties = {
    ...(schema.properties || {}),
    deviceId: structuredClone(deviceSchema),
  };
  schema.required = Array.from(new Set([
    ...(schema.required || []),
    'deviceId',
  ]));
  return schema;
}

export function stripDeviceRoutingArguments(args) {
  const forwarded = { ...(args || {}) };
  delete forwarded.deviceId;
  return forwarded;
}
