export const DEFAULT_MAX_DC_RESPONSE_BYTES = 512 * 1024;

export function resolveMaxDcResponseBytes(value) {
  const parsed = Number(value || DEFAULT_MAX_DC_RESPONSE_BYTES);
  return Number.isFinite(parsed) && parsed >= 64 * 1024
    ? parsed
    : DEFAULT_MAX_DC_RESPONSE_BYTES;
}

export function guardDesktopCommanderMessage(message, responseBytes, maxBytes) {
  if (!message || message.id === undefined || message.id === null) return message;
  if (!Number.isFinite(responseBytes) || responseBytes <= maxBytes) return message;
  return {
    jsonrpc: message.jsonrpc || '2.0',
    id: message.id,
    error: {
      code: -32099,
      message: `Desktop Commander response blocked by worker safety limit (${responseBytes} > ${maxBytes} bytes). Use paginated/text processing or reduce media size.`
    }
  };
}