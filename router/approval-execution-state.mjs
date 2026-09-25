const EXECUTION_UNKNOWN_PATTERN =
  /(?:worker request timed out|worker disconnected|worker connection replaced|worker hub stopped)/i;

export function approvalFailureState(error) {
  const text = String(error?.message || error || '');
  return EXECUTION_UNKNOWN_PATTERN.test(text)
    ? 'execution_unknown'
    : 'approved_retryable';
}
