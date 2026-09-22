const COMMAND_BLOCK_MARKER = 'Error: Command not allowed';
const NONZERO_EXIT_PATTERN = /(?:Process completed with exit code\s+|Execution failed \(exit code\s*)[1-9]\d*/i;
const SHELL_FAILURE_PATTERN = /(?:CommandNotFoundException|FullyQualifiedErrorId\s*:|CategoryInfo\s*:|ObjectNotFound:)/i;
const TRANSIENT_TRANSPORT_PATTERN = /(?:network is unreachable|network[_ -]?error|econnreset|connection reset|socket hang up|timed? out|timeout|http\s*(?:403|404|502)|bad gateway|dns\s+(?:failure|error)|enotfound|eai_again|worker disconnected|worker connection replaced|worker request timed out|verification challenge|captcha|cloudflare)/i;

export const WCM_TOOL_FAILURE_RULE =
  'WCM FAILURE RULE: only the exact marker "Error: Command not allowed" is a WCM command-block refusal. ' +
  'Network/timeout/disconnect/502/HTTP/DNS/process errors are not GPT safety-review signals. ' +
  'For transient failures, check list_devices and retry before declaring WCM or a device unavailable.';

export const WCM_ERROR_SEMANTICS =
  'WCM error semantics: only the exact marker "Error: Command not allowed" means a WCM command-blocklist refusal. ' +
  'Other errors, including schema, argument, path, command-not-found, process, non-zero-exit, timeout, disconnect, HTTP 502, or missing-result failures, are not command-blocklist refusals and are not evidence of a GPT safety review. ' +
  'WCM and target-device network connectivity can be transiently unstable: a single Network is unreachable, DNS failure, timeout, connection reset, HTTP 403/404, target-site verification/challenge, or similar network/site error does not mean WCM or the target device is unavailable. ' +
  'First distinguish device connectivity from command/runtime/network/target-site failures; use list_devices to verify device state, retry transient network requests 2-3 times when appropriate, and use curl or an alternate source when useful. Only treat WCM/device connectivity as unavailable when the device is reported offline or repeated harmless local WCM checks fail. ' +
  'Only classify a GPT/OpenAI safety-review or refusal event when an explicit, observable safety-policy refusal or other verifiable safety-review signal is present; when feasible, verify the target-side state with a harmless read-only check before concluding. ' +
  'When such a GPT safety-review/refusal is verified and WCM file writing remains available, append a concise entry to the Git-ignored local file logs/gpt-safety-review.log with timestamp, deviceId, tool/action, intended operation, the brief observable refusal signal, relevant WCM classification, and any target-state verification; never log credentials, cookies, tokens, or unrelated sensitive data, and never claim the entry was written if the write could not be performed.';

function classificationMarker(classification, deviceOnline = null) {
  const fields = [
    `WCM_CLASSIFICATION=${classification}`,
    'GPT_SAFETY_REVIEW_INDICATED=false',
  ];
  if (typeof deviceOnline === 'boolean') {
    fields.push(`DEVICE_ONLINE=${deviceOnline}`);
  }
  if (classification === 'transient_transport_error') {
    fields.push('ACTION=verify_device_then_retry');
  }
  return fields.join(' ');
}

export function classifyToolResult(result, context = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  const text = result.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const blocked = result.isError === true && result.content.some((item) =>
    item?.type === 'text' && typeof item.text === 'string' && item.text.trimStart().startsWith(COMMAND_BLOCK_MARKER)
  );
  const nonzero = NONZERO_EXIT_PATTERN.test(text);
  const shellFailure = SHELL_FAILURE_PATTERN.test(text);
  const nonBlockFailure = result.isError === true || nonzero || shellFailure;
  if (!blocked && !nonBlockFailure) return result;

  const transient = !blocked && TRANSIENT_TRANSPORT_PATTERN.test(text) &&
    (result.isError === true || nonzero || shellFailure);
  const classification = blocked
    ? 'command_blocked'
    : transient
      ? 'transient_transport_error'
      : 'runtime_error';
  const deviceOnline = typeof context.deviceOnline === 'boolean'
    ? context.deviceOnline
    : null;
  const marker = classificationMarker(classification, deviceOnline);
  if (text.includes(`WCM_CLASSIFICATION=${classification}`)) return result;

  const existingStructured = result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
    ? result.structuredContent
    : {};
  return {
    ...result,
    structuredContent: {
      ...existingStructured,
      wcm_classification: classification,
      gpt_safety_review_indicated: false,
      ...(typeof deviceOnline === 'boolean' ? { device_online: deviceOnline } : {}),
      ...(classification === 'transient_transport_error'
        ? { retry_recommended: true }
        : {}),
    },
    content: [{ type: 'text', text: marker }, ...result.content],
  };
}
