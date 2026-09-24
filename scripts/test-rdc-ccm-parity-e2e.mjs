import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../rdc-sidecar/config.mjs';
import { createPkceChallenge } from '../rdc-sidecar/oauth.mjs';
import { APPROVAL_TEST_UI_URI } from '../router/approval-test-routing.mjs';

const config = loadConfig(process.cwd());
const sidecarBase = process.env.RDC_E2E_BASE_URL || `http://${config.host}:${config.port}`;
const localRouterUrl = new URL(process.env.WCM_CCM_PARITY_ROUTER_URL || 'http://127.0.0.1:18009/mcp-ccm');
const parityResource = new URL('/rdc/mcp-ccm', config.resource).toString();
const redirectUri = 'http://127.0.0.1:19003/rdc-ccm-parity-e2e-callback';
let stage = 'startup';

async function request(path, options = {}) {
  const response = await fetch(sidecarBase + path, { redirect: 'manual', ...options });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { response, text, json };
}

function requireStatus(result, expected) {
  if (result.response.status !== expected) {
    throw new Error(`${stage}: HTTP ${result.response.status}, expected ${expected}. ${result.text.slice(0, 500)}`);
  }
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function getAccessToken(approvalSecret) {
  stage = 'parity resource discovery';
  const metadata = await request('/.well-known/oauth-protected-resource/rdc/mcp-ccm');
  requireStatus(metadata, 200);
  if (metadata.json?.resource !== parityResource) {
    throw new Error(`parity resource metadata mismatch: ${metadata.json?.resource}`);
  }

  stage = 'registration';
  const registration = await request('/rdc/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Windows Console CCM parity E2E',
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
  stage = 'authorization';
  const authorization = await request('/rdc/authorize?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: createPkceChallenge(verifier),
    code_challenge_method: 'S256',
    resource: parityResource,
    scope: 'mcp',
    state: 'ccm-parity-e2e',
  }).toString());
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
  requireStatus(consent, 302);
  const callback = new URL(consent.response.headers.get('location'));
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
      resource: parityResource,
    }).toString(),
  });
  requireStatus(token, 200);
  if (token.json?.resource !== parityResource) throw new Error('token resource mismatch.');
  if (!token.json?.access_token || !token.json?.refresh_token) throw new Error('token response was incomplete.');
  return {
    accessToken: token.json.access_token,
    refreshToken: token.json.refresh_token,
  };
}

async function connectClient(url, accessToken = null) {
  const transport = new StreamableHTTPClientTransport(url, accessToken ? {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  } : undefined);
  const client = new Client({ name: 'wcm-ccm-parity-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function verifySurface(client, { exerciseApproval = false } = {}) {
  const tools = (await client.listTools()).tools;
  for (const name of ['list_devices', 'approval_test_exec', 'request_approval', 'resolve_pending_action']) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`SDK tools/list is missing ${name}.`);
  }
  const requestApproval = tools.find((tool) => tool.name === 'request_approval');
  if (requestApproval?._meta?.['openai/outputTemplate'] !== APPROVAL_TEST_UI_URI) {
    throw new Error('request_approval outputTemplate mismatch.');
  }

  const resources = (await client.listResources()).resources;
  if (!resources.some((resource) => resource.uri === APPROVAL_TEST_UI_URI)) {
    throw new Error('SDK resources/list is missing the WCM approval View.');
  }
  const read = await client.readResource({ uri: APPROVAL_TEST_UI_URI });
  const content = read.contents?.[0];
  if (content?.mimeType !== 'text/html;profile=mcp-app' ||
      !String(content?.text || '').includes('name: "resolve_pending_action"')) {
    throw new Error('SDK resources/read returned the wrong WCM approval View.');
  }

  if (!exerciseApproval) return;
  const devices = await client.callTool({ name: 'list_devices', arguments: {} });
  const deviceInfo = JSON.parse(devices.content?.[0]?.text || '{}');
  const deviceId = deviceInfo.defaultDeviceId || deviceInfo.devices?.find((item) => item.online)?.deviceId;
  if (!deviceId) throw new Error('list_devices did not return a target device.');

  const sessionMeta = { 'openai/session': 'wcm-ccm-parity-e2e-session' };
  const frozen = await client.callTool({
    name: 'approval_test_exec',
    arguments: { deviceId, justification: 'CCM parity transport E2E deny test.' },
  });
  const approvalId = frozen.structuredContent?.approval_id;
  if (!approvalId) throw new Error('approval_test_exec did not return approval_id.');
  const card = await client.callTool({
    name: 'request_approval',
    arguments: { approval_id: approvalId },
    _meta: sessionMeta,
  });
  const nonce = card._meta?.approval_nonce;
  if (!nonce) throw new Error('request_approval did not return hidden approval_nonce.');
  const denied = await client.callTool({
    name: 'resolve_pending_action',
    arguments: { approval_id: approvalId, approval_nonce: nonce, decision: 'deny' },
    _meta: sessionMeta,
  });
  if (denied.structuredContent?.state !== 'denied') {
    throw new Error('resolve_pending_action did not deny the frozen action.');
  }
}

async function main() {
  stage = 'local router SDK transport';
  const local = await connectClient(localRouterUrl);
  try {
    await verifySurface(local.client);
    if (!local.transport.sessionId) throw new Error('local SDK transport did not establish an MCP session.');
  } finally {
    await local.client.close();
  }

  const approvalSecret = fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
  if (approvalSecret.length < 16) throw new Error('Approval secret is not configured.');
  const { accessToken, refreshToken } = await getAccessToken(approvalSecret);

  stage = 'sidecar SDK transport';
  const sidecar = await connectClient(new URL(sidecarBase + '/rdc/mcp-ccm'), accessToken);
  try {
    await verifySurface(sidecar.client, { exerciseApproval: true });
    if (!sidecar.transport.sessionId) throw new Error('sidecar SDK transport did not preserve MCP session state.');
  } finally {
    await sidecar.client.close();
  }

  stage = 'revocation';
  const revoke = await request('/rdc/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  requireStatus(revoke, 200);

  console.log('RDC CCM parity E2E: PASS');
  console.log('router_sdk_streamable_http=PASS');
  console.log('sidecar_oauth_resource_alias=PASS');
  console.log('sidecar_sdk_session=PASS');
  console.log('approval_deny_roundtrip=PASS');
}

main().catch((error) => {
  console.error(`RDC CCM parity E2E: FAIL at ${stage}. ${String(error?.message || error)}`);
  process.exitCode = 1;
});
