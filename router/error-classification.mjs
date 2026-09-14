const COMMAND_BLOCK_MARKER = 'Error: Command not allowed';
const NONZERO_EXIT_PATTERN = /(?:Process completed with exit code\s+|Execution failed \(exit code\s*)[1-9]\d*/i;
const SHELL_FAILURE_PATTERN = /(?:CommandNotFoundException|FullyQualifiedErrorId\s*:|CategoryInfo\s*:|ObjectNotFound:)/i;

export const WCM_ERROR_SEMANTICS =
  'WCM error semantics: only the exact marker "Error: Command not allowed" means a WCM command-blocklist refusal. ' +
  'Other errors, including schema, argument, path, command-not-found, process, and non-zero-exit failures, are not command-blocklist refusals.';

export function classifyToolResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  const text = result.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const blocked = result.isError === true && result.content.some((item) =>
    item?.type === 'text' && typeof item.text === 'string' && item.text.trimStart().startsWith(COMMAND_BLOCK_MARKER)
  );
  const nonBlockFailure = result.isError === true || NONZERO_EXIT_PATTERN.test(text) || SHELL_FAILURE_PATTERN.test(text);
  if (!blocked && !nonBlockFailure) return result;
  const marker = blocked
    ? 'WCM classification: command_blocked. Treat this as a WCM command-blocklist refusal.'
    : 'WCM classification: non_block_error. This is not a WCM command-blocklist refusal; debug the tool call or runtime failure first.';
  if (text.includes(marker)) return result;
  return { ...result, content: [{ type: 'text', text: marker }, ...result.content] };
}
