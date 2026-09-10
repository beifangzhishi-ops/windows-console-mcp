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
const platformResult = await call('get_config', { deviceId });
const platformText = platformResult?.content?.[0]?.text || '';
const jsonStart = platformText.indexOf('{');
if (jsonStart < 0) throw new Error('Target get_config response did not contain JSON.');
let platformConfig;
try { platformConfig = JSON.parse(platformText.slice(jsonStart)); }
catch { throw new Error('Could not parse target get_config response.'); }
const isWindows = platformConfig?.systemInfo?.isWindows === true;
const slowArgs = isWindows
  ? {
      deviceId,
      command: "Start-Sleep -Milliseconds 500; Write-Output CONCURRENCY_SLOW_OK",
      timeout_ms: 3000,
      shell: 'powershell.exe',
    }
  : {
      deviceId,
      command: "sleep 0.5; printf 'CONCURRENCY_SLOW_OK\\n'",
      timeout_ms: 3000,
      shell: '/bin/sh',
    };
const [slow, config] = await Promise.all([
  call('start_process', slowArgs),
  call('get_config', { deviceId }),
]);
const slowText = slow?.content?.[0]?.text || '';
const configText = config?.content?.[0]?.text || '';
if (!slowText.includes('CONCURRENCY_SLOW_OK')) throw new Error('start_process response was mismatched or incomplete.');
if (!configText.includes('blockedCommands')) throw new Error('get_config response was mismatched or incomplete.');
console.log(`RPC concurrency regression passed for ${deviceId}: duplicate external id=0 remained correctly correlated.`);