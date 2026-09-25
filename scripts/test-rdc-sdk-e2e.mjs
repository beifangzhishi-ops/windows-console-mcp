import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../rdc-sidecar/config.mjs';
import { createPkceChallenge } from '../rdc-sidecar/oauth.mjs';
import { APPROVAL_UI_URI } from '../router/approval-routing.mjs';

const config = loadConfig(process.cwd());
const sidecarBase = process.env.RDC_E2E_BASE_URL || `http://${config.host}:${config.port}`;
const localRouterUrl = new URL(process.env.WCM_SDK_ROUTER_URL || 'http://127.0.0.1:18009/mcp');
const sdkResource = config.resource;
const redirectUri = 'http://127.0.0.1:19003/rdc-sdk-e2e-callback';
let stage = 'startup';
const approvalDecision = process.env.RDC_E2E_APPROVAL_DECISION || 'deny';
const approvalDurationSeconds = Number(process.env.RDC_E2E_APPROVAL_DURATION_SECONDS || 120);
const omitApprovalDuration = process.env.RDC_E2E_OMIT_APPROVAL_DURATION === '1';
const expectedApprovalDurationSeconds = omitApprovalDuration ? 21600 : approvalDurationSeconds;
let approvalFlowExercised = false;

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
  stage = 'SDK resource discovery';
  const metadata = await request('/.well-known/oauth-protected-resource/rdc/mcp');
  requireStatus(metadata, 200);
  if (metadata.json?.resource !== sdkResource) {
    throw new Error(`SDK resource metadata mismatch: ${metadata.json?.resource}`);
  }
  stage = 'registration';
  const registration = await request('/rdc/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Windows Console SDK E2E',
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
    resource: sdkResource,
    scope: 'mcp',
    state: 'sdk-e2e',
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
      resource: sdkResource,
    }).toString(),
  });
  requireStatus(token, 200);
  if (token.json?.resource !== sdkResource) throw new Error('token resource mismatch.');
  if (!token.json?.access_token || !token.json?.refresh_token) throw new Error('token response was incomplete.');

  stage = 'refresh token rotation';
  const refresh = await request('/rdc/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: token.json.refresh_token,
      resource: sdkResource,
    }).toString(),
  });
  requireStatus(refresh, 200);
  if (!refresh.json?.access_token || !refresh.json?.refresh_token) {
    throw new Error('refresh token rotation did not return a complete token pair.');
  }
  if (refresh.json.refresh_token === token.json.refresh_token) {
    throw new Error('refresh token rotation reused the previous refresh token.');
  }
  return {
    accessToken: refresh.json.access_token,
    refreshToken: refresh.json.refresh_token,
  };
}

async function connectClient(url, accessToken = null) {
  const transport = new StreamableHTTPClientTransport(url, accessToken ? {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  } : undefined);
  const client = new Client({ name: 'wcm-sdk-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function verifySurface(client, { exerciseApproval = false } = {}) {
  const tools = (await client.listTools()).tools;
  for (const name of [
    'list_devices',
    'approval_status',
    'call_with_approval',
    'request_approval',
    'resolve_pending_action',
  ]) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`SDK tools/list is missing ${name}.`);
  }
  const requestApproval = tools.find((tool) => tool.name === 'request_approval');
  if (requestApproval?._meta?.['openai/outputTemplate'] !== APPROVAL_UI_URI) {
    throw new Error('request_approval outputTemplate mismatch.');
  }
  if (requestApproval?.inputSchema?.properties?.duration_seconds?.default !== 21600) {
    throw new Error('request_approval duration_seconds default mismatch.');
  }

  const resources = (await client.listResources()).resources;
  if (resources.length !== 1 || resources[0]?.uri !== APPROVAL_UI_URI) {
    throw new Error('SDK resources/list is missing the WCM approval View.');
  }
  const read = await client.readResource({ uri: APPROVAL_UI_URI });
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

  const ordinary = await client.callTool({ name: 'get_config', arguments: { deviceId } });
  if (deviceInfo.approval?.mode === 'off') {
    if (approvalDecision === 'approve') {
      throw new Error('approve E2E requested while WCM approval mode is off.');
    }
    if (ordinary.isError) throw new Error('ordinary get_config routing failed in off mode.');
    return;
  }
  approvalFlowExercised = true;
  if (ordinary.structuredContent?.approval_required !== true) {
    throw new Error('timed mode get_config did not return approval_required=true.');
  }

  const sessionMeta = { 'openai/session': 'wcm-sdk-e2e-session' };
  const approvalId = ordinary.structuredContent?.approval_id;
  if (!approvalId) throw new Error('gated get_config did not return approval_id.');
  const approvalArguments = omitApprovalDuration
    ? { approval_id: approvalId }
    : { approval_id: approvalId, duration_seconds: approvalDurationSeconds };
  const card = await client.callTool({
    name: 'request_approval',
    arguments: approvalArguments,
    _meta: sessionMeta,
  });
  const nonce = card._meta?.approval_nonce;
  if (!nonce) throw new Error('request_approval did not return hidden approval_nonce.');
  const resolved = await client.callTool({
    name: 'resolve_pending_action',
    arguments: { approval_id: approvalId, approval_nonce: nonce, decision: approvalDecision },
    _meta: sessionMeta,
  });
  if (approvalDecision === 'deny') {
    if (resolved.structuredContent?.state !== 'denied') {
      throw new Error('resolve_pending_action did not deny the frozen action.');
    }
    return;
  }
  if (approvalDecision !== 'approve') {
    throw new Error('RDC_E2E_APPROVAL_DECISION must be deny or approve.');
  }
  if (resolved.structuredContent?.grant_active !== true) {
    throw new Error('approve did not create an active timed grant.');
  }
  if (resolved.structuredContent?.requested_duration_seconds !== expectedApprovalDurationSeconds) {
    throw new Error('approve did not preserve the requested duration.');
  }
  if (resolved.structuredContent?.action_state !== 'consumed' ||
      resolved.structuredContent?.action_failed === true) {
    throw new Error('approved owner get_config did not complete exactly once.');
  }

  const usage = await client.callTool({
    name: 'call_with_approval',
    arguments: {
      approval_id: approvalId,
      deviceId,
      tool_name: 'get_usage_stats',
      arguments: {},
    },
  });
  if (usage.isError) {
    throw new Error('call_with_approval did not use the active grant.');
  }

  const fresh = await client.callTool({
    name: 'get_usage_stats',
    arguments: { deviceId },
  });
  if (fresh.structuredContent?.approval_required !== true) {
    throw new Error('normal routed call did not create a fresh independent approval while another grant was active.');
  }
  const freshApprovalId = fresh.structuredContent?.approval_id;
  const freshCard = await client.callTool({
    name: 'request_approval',
    arguments: { approval_id: freshApprovalId, duration_seconds: 60 },
    _meta: sessionMeta,
  });
  const freshNonce = freshCard._meta?.approval_nonce;
  if (!freshNonce) throw new Error('fresh independent approval did not bind a card.');
  const freshApproved = await client.callTool({
    name: 'resolve_pending_action',
    arguments: {
      approval_id: freshApprovalId,
      approval_nonce: freshNonce,
      decision: 'approve',
    },
    _meta: sessionMeta,
  });
  if (freshApproved.structuredContent?.grant_active !== true ||
      freshApproved.structuredContent?.action_state !== 'consumed') {
    throw new Error('fresh independent approval B did not become active and consume its owner action.');
  }

  const secondDevice = deviceInfo.devices?.find((item) => item.online && item.deviceId !== deviceId)?.deviceId;
  if (secondDevice) {
    const crossDevice = await client.callTool({
      name: 'call_with_approval',
      arguments: {
        approval_id: approvalId,
        deviceId: secondDevice,
        tool_name: 'get_config',
        arguments: {},
      },
    });
    if (crossDevice.isError) {
      throw new Error('active approval-id grant did not cover another registered device.');
    }
  }

  const approvalStatus = await client.callTool({
    name: 'approval_status',
    arguments: { approval_id: approvalId },
  });
  if (approvalStatus.structuredContent?.grant_state !== 'active' ||
      approvalStatus.structuredContent?.usable !== true) {
    throw new Error('approval_status did not report the approved ID as active and usable.');
  }
  const freshApprovalStatus = await client.callTool({
    name: 'approval_status',
    arguments: { approval_id: freshApprovalId },
  });
  if (freshApprovalStatus.structuredContent?.grant_state !== 'active' ||
      freshApprovalStatus.structuredContent?.usable !== true) {
    throw new Error('approval_status did not report the second approved ID as active and usable.');
  }

  const status = await client.callTool({ name: 'list_devices', arguments: {} });
  const statusInfo = JSON.parse(status.content?.[0]?.text || '{}');
  if (!(statusInfo.approval?.grant_count >= 2)) {
    throw new Error('list_devices did not report both active approval-id grants.');
  }
  if ('grant_approval_id' in (statusInfo.approval || {}) ||
      'pending_approval_id' in (statusInfo.approval || {})) {
    throw new Error('list_devices leaked raw approval IDs.');
  }
}

async function main() {
  stage = 'removed alias routes';
  const removedAlias = await request('/rdc/mcp-ccm');
  requireStatus(removedAlias, 404);
  const removedAliasMetadata = await request('/.well-known/oauth-protected-resource/rdc/mcp-ccm');
  requireStatus(removedAliasMetadata, 404);

  stage = 'unauthenticated canonical MCP';
  const unauthenticated = await request('/rdc/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'unauthenticated-e2e',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'unauthenticated-e2e', version: '1.0.0' },
      },
    }),
  });
  requireStatus(unauthenticated, 401);

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
  const sidecar = await connectClient(new URL(sidecarBase + '/rdc/mcp'), accessToken);
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

  console.log('RDC SDK MCP E2E: PASS');
  console.log('router_sdk_streamable_http=PASS');
  console.log('sidecar_oauth_resource=PASS');
  console.log('refresh_token_rotation=PASS');
  console.log('sidecar_sdk_session=PASS');
  console.log('removed_alias_routes=PASS');
  console.log('oauth_gate=PASS');
  console.log('approval_mode_routing=PASS');
  if (approvalFlowExercised) {
    console.log(`approval_${approvalDecision}_roundtrip=PASS`);
  } else {
    console.log('approval_off_direct_routing=PASS');
  }
}

main().catch((error) => {
  console.error(`RDC SDK MCP E2E: FAIL at ${stage}. ${String(error?.message || error)}`);
  process.exitCode = 1;
});
