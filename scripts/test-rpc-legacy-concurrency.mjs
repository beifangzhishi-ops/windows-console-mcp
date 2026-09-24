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
  const body = {
    jsonrpc: '2.0',
    id: 0,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  };
  try {
    const response = await fetch(`${routerBase}/mcp-legacy`, {
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

async function prepare() {
  const frozen = await call('approval_test_exec', {
    deviceId,
  });
  const approvalId = frozen?.structuredContent?.approval_id;
  if (!approvalId) throw new Error('approval_test_exec did not return approval_id.');
  const card = await call('request_approval', { approval_id: approvalId });
  const approvalNonce = card?._meta?.approval_nonce;
  if (!approvalNonce) throw new Error('request_approval did not return approval nonce.');
  return { approvalId, approvalNonce };
}

const slow = await prepare();
const fast = await prepare();

const [slowResult, fastResult] = await Promise.all([
  call('resolve_pending_action', {
    approval_id: slow.approvalId,
    approval_nonce: slow.approvalNonce,
    decision: 'approve',
  }),
  call('resolve_pending_action', {
    approval_id: fast.approvalId,
    approval_nonce: fast.approvalNonce,
    decision: 'approve',
  }),
]);

if (slowResult?.structuredContent?.approval_id !== slow.approvalId ||
    !String(slowResult?.structuredContent?.output || '').trim()) {
  throw new Error('First approval test response was mismatched or incomplete.');
}
if (fastResult?.structuredContent?.approval_id !== fast.approvalId ||
    !String(fastResult?.structuredContent?.output || '').trim()) {
  throw new Error('Second approval test response was mismatched or incomplete.');
}

console.log(`RPC concurrency regression passed for ${deviceId}: duplicate external id=0 remained correctly correlated.`);
