const routerBase = process.env.WCM_ROUTER_URL || 'http://127.0.0.1:18009';
const healthResponse = await fetch(`${routerBase}/health`);
if (!healthResponse.ok) throw new Error(`router health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
const deviceId = process.env.WCM_TEST_DEVICE_ID || health.defaultDeviceId;
if (!deviceId) throw new Error('No default test device is available.');
const headers = { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' };

async function call(name, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const body = { jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name, arguments: args } };
  try {
    const response = await fetch(`${routerBase}/mcp`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    const json = await response.json();
    if (json.id !== 0) throw new Error(`${name} response id was not restored to 0.`);
    if (json.error) throw new Error(`${name} returned JSON-RPC error: ${JSON.stringify(json.error)}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(command) {
  const frozen = await call('approval_test_exec', {
    deviceId,
    command,
    timeout_ms: 5000,
  });
  const approvalId = frozen?.structuredContent?.approval_id;
  if (!approvalId) throw new Error('approval_test_exec did not return approval_id.');
  const card = await call('request_approval_test', { approval_id: approvalId });
  const approvalNonce = card?._meta?.approval_nonce;
  if (!approvalNonce) throw new Error('request_approval_test did not return approval nonce.');
  return { approvalId, approvalNonce };
}

const slow = await prepare(
  `node -e "setTimeout(() => console.log('CONCURRENCY_SLOW_OK'), 500)"`,
);
const fast = await prepare(
  `node -e "console.log('CONCURRENCY_FAST_OK')"`,
);

const [slowResult, fastResult] = await Promise.all([
  call('resolve_approval_test', {
    approval_id: slow.approvalId,
    approval_nonce: slow.approvalNonce,
    decision: 'approve',
  }),
  call('resolve_approval_test', {
    approval_id: fast.approvalId,
    approval_nonce: fast.approvalNonce,
    decision: 'approve',
  }),
]);

const slowText = String(slowResult?.structuredContent?.output || '');
const fastText = String(fastResult?.structuredContent?.output || '');
if (!slowText.includes('CONCURRENCY_SLOW_OK')) {
  throw new Error('Slow approval test response was mismatched or incomplete.');
}
if (!fastText.includes('CONCURRENCY_FAST_OK')) {
  throw new Error('Fast approval test response was mismatched or incomplete.');
}

console.log(`RPC concurrency regression passed for ${deviceId}: duplicate external id=0 remained correctly correlated.`);
