export const DEFAULT_MAX_ROUTER_TOOL_RESULT_BYTES = 512 * 1024;

export function resolveMaxRouterToolResultBytes(value) {
  const parsed = Number(value || DEFAULT_MAX_ROUTER_TOOL_RESULT_BYTES);
  return Number.isFinite(parsed) && parsed >= 64 * 1024
    ? parsed
    : DEFAULT_MAX_ROUTER_TOOL_RESULT_BYTES;
}

export function guardRouterToolResult(result, maxBytes) {
  const responseBytes = Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8');
  if (responseBytes <= maxBytes) {
    return { blocked: false, responseBytes, result };
  }
  return {
    blocked: true,
    responseBytes,
    result: {
      content: [{
        type: 'text',
        text: `WCM router blocked oversized tool result (${responseBytes} > ${maxBytes} bytes). Use pagination, fewer files, or reduce media size.`,
      }],
      isError: true,
    },
  };
}
