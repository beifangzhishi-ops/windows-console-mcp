import fs from 'node:fs';
import { loadConfig } from '../rdc-sidecar/config.mjs';
import { createPkceChallenge } from '../rdc-sidecar/oauth.mjs';

const config = loadConfig(process.cwd());
const baseUrl = process.env.RDC_E2E_BASE_URL || `http://${config.host}:${config.port}`;
const redirectUri = 'http://127.0.0.1:19002/rdc-modern-e2e-callback';
const protocol = '2026-07-28';
let stage = 'startup';

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, { redirect: 'manual', ...options });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, text, json };
}

function requireStatus(result, status) {
  if (result.response.status !== status) {
    throw new Error(`${stage}: HTTP ${result.response.status}, expected ${status}.`);
  }
}function randomVerifier() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function getAccessToken(approvalSecret) {
  stage = 'registration';
  const registration = await request('/rdc/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Windows Console Modern E2E',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  requireStatus(registration, 201);
  const clientId = registration.json?.client_id;
  if (!clientId) throw new Error('registration did not return client_id.');

  const verifier = randomVerifier();
  const challenge = createPkceChallenge(verifier);  stage = 'authorization';
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: config.resource,
    scope: 'mcp',
    state: 'modern-e2e',
  });
  const authorization = await request('/rdc/authorize?' + query.toString());
  requireStatus(authorization, 302);
  const consentLocation = new URL(authorization.response.headers.get('location'));

  stage = 'consent';
  const consentForm = new URLSearchParams(consentLocation.search);
  consentForm.set('approval_secret', approvalSecret);
  const consent = await request('/rdc/oauth/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: consentForm.toString(),
  });
  requireStatus(consent, 302);  const callback = new URL(consent.response.headers.get('location'));
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('consent did not return authorization code.');

  stage = 'token';
  const token = await request('/rdc/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: config.resource,
    }).toString(),
  });
  requireStatus(token, 200);
  const accessToken = token.json?.access_token;
  const refreshToken = token.json?.refresh_token;
  if (!accessToken || !refreshToken) throw new Error('token response was incomplete.');
  return { accessToken, refreshToken };
}

function modernHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': protocol,
  };
}async function mcp(accessToken, id, method, params = {}) {
  stage = method;
  const result = await request('/rdc/mcp', {
    method: 'POST',
    headers: modernHeaders(accessToken),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  requireStatus(result, 200);
  if (!result.json || result.json.error) {
    throw new Error(`${method} returned an invalid JSON-RPC result.`);
  }
  return result.json.result;
}

async function runModern(approvalSecret) {
  const { accessToken, refreshToken } = await getAccessToken(approvalSecret);

  const discover = await mcp(accessToken, 1, 'server/discover', {});
  if (discover?.resultType !== 'complete') throw new Error('server/discover resultType is not complete.');
  if (!discover?.supportedVersions?.includes(protocol)) {
    throw new Error('server/discover did not advertise 2026-07-28.');
  }
  if (!discover?.capabilities?.tools) throw new Error('server/discover did not advertise tools.');
  if (discover?.capabilities?.tools?.listChanged !== true) {
    throw new Error('server/discover did not advertise tools.listChanged=true.');
  }
  if (!discover?.capabilities?.resources) throw new Error('server/discover did not advertise resources.');
  const toolsResult = await mcp(accessToken, 2, 'tools/list', {});
  const tools = toolsResult?.tools;
  if (!Array.isArray(tools) || tools.length < 20) throw new Error('tools/list returned too few tools.');
  const listDevicesTool = tools.find((tool) => tool?.name === 'list_devices');
  const getConfigTool = tools.find((tool) => tool?.name === 'get_config');
  if (!listDevicesTool || !getConfigTool) throw new Error('required routed tools were not listed.');
  if (!getConfigTool.inputSchema?.required?.includes('deviceId')) {
    throw new Error('get_config does not require deviceId.');
  }
  for (const name of ['read_file', 'edit_block']) {
    const tool = tools.find((candidate) => candidate?.name === name);
    if (!tool) throw new Error(`${name} was not listed.`);
    const meta = tool._meta || {};
    if (meta['openai/outputTemplate'] || meta['ui/resourceUri'] || meta.ui || meta['openai/widgetAccessible']) {
      throw new Error(`${name} still exposes UI template metadata.`);
    }
  }

  const devices = await mcp(accessToken, 3, 'tools/call', {
    name: 'list_devices', arguments: {},
  });
  if (devices?.isError === true) throw new Error('list_devices returned an error.');
  const deviceText = devices?.content?.[0]?.text || '';
  let deviceInfo;
  try { deviceInfo = JSON.parse(deviceText); }
  catch { throw new Error('list_devices did not return valid JSON.'); }
  const targetDeviceId = deviceInfo?.defaultDeviceId || deviceInfo?.devices?.find((item) => item?.online)?.deviceId;
  if (!targetDeviceId) throw new Error('list_devices did not expose an online/default device.');

  const targetConfig = await mcp(accessToken, 4, 'tools/call', {
    name: 'get_config', arguments: { deviceId: targetDeviceId },
  });
  if (targetConfig?.isError === true || !Array.isArray(targetConfig?.content)) {
    throw new Error(`get_config(deviceId=${targetDeviceId}) failed.`);
  }

  const resourcesResult = await mcp(accessToken, 5, 'resources/list', {});
  const resources = resourcesResult?.resources;
  const filePreviewUri = 'ui://desktop-commander/file-preview';
  if (!Array.isArray(resources) || !resources.some((item) => item?.uri === filePreviewUri)) {
    throw new Error('resources/list did not include file preview UI.');
  }
  const resourceRead = await mcp(accessToken, 6, 'resources/read', { uri: filePreviewUri });
  const html = resourceRead?.contents?.[0]?.text || '';
  if (!html.includes('<html') && !html.includes('<!DOCTYPE html')) {
    throw new Error('resources/read did not return the file preview HTML.');
  }
  const templates = await mcp(accessToken, 7, 'resources/templates/list', {});
  if (!Array.isArray(templates?.resourceTemplates)) {
    throw new Error('resources/templates/list did not return an array.');
  }
  stage = 'revocation';
  const revoke = await request('/rdc/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  requireStatus(revoke, 200);

  const stateText = fs.readFileSync(config.stateFile, 'utf8');
  for (const secret of [accessToken, refreshToken, approvalSecret]) {
    if (stateText.includes(secret)) throw new Error('OAuth state contains plaintext secret material.');
  }
  return { toolCount: tools.length };
}

async function main() {
  const approvalSecret = fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
  if (approvalSecret.length < 16) throw new Error('Approval secret is not configured.');
  const result = await runModern(approvalSecret);
  console.log('RDC Modern MCP E2E: PASS');
  console.log('protocol=2026-07-28');
  console.log('server_discover=PASS');
  console.log('tools_count=' + result.toolCount);
  console.log('list_devices=PASS');
  console.log('target_get_config=PASS');
  console.log('resources_list=PASS');
  console.log('resources_read=PASS');
  console.log('resource_templates_list=PASS');
}

main().catch((error) => {
  console.error('RDC Modern MCP E2E: FAIL at ' + stage + '. ' + String(error?.message || error));
  process.exitCode = 1;
});