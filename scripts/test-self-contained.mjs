import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConfig } from '../rdc-sidecar/config.mjs';
import {
  OAuthStore,
  OAUTH_POLICY,
  createPkceChallenge,
} from '../rdc-sidecar/oauth.mjs';
import { WorkerHub } from '../router/worker-hub.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-test-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function registrationMetadata() {
  return {
    client_name: 'self-contained-test',
    redirect_uris: ['http://127.0.0.1:19001/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
async function testConfigAndOAuth() {
  const config = createConfig({
    rootDir: tempRoot,
    readEnvFile: false,
    envValues: {
      RDC_ISSUER: 'https://demo.example.com/rdc',
      RDC_RESOURCE: 'https://demo.example.com/rdc/mcp',
    },
    allowEphemeral: true,
  });
  assert.equal(config.issuer, 'https://demo.example.com/rdc');
  assert.equal(config.resource, 'https://demo.example.com/rdc/mcp');

  let now = Date.now();
  const stateFile = path.join(tempRoot, 'oauth-state.json');
  const store = new OAuthStore(stateFile, () => now);
  assert.throws(
    () => store.registerClient({
      ...registrationMetadata(),
      redirect_uris: ['http://example.com/callback'],
    }),
    (error) => error?.code === 'invalid_redirect_uri',
  );
  const client = store.registerClient(registrationMetadata());
  const verifier = 'A'.repeat(43);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: registrationMetadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const pair = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: registrationMetadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  });
  assert.equal(store.validateAccessToken(pair.accessToken, config.resource)?.clientId, client.clientId);
  const rotated = store.exchangeRefreshToken({
    refreshToken: pair.refreshToken,
    clientId: client.clientId,
    resource: config.resource,
    scope: null,
    tokenTtlSeconds: 3600,
  });
  assert.notEqual(rotated.refreshToken, pair.refreshToken);
  assert.equal(store.revokeToken(rotated.refreshToken), true);
  assert.equal(store.validateAccessToken(rotated.accessToken, config.resource), null);

  const staleId = 'stale-client';
  store.state.clients[staleId] = {
    clientId: staleId,
    createdAt: now - (OAUTH_POLICY.clientTtlSeconds + 1) * 1000,
  };
  store.state.accessTokens.expired = {
    clientId: staleId,
    resource: config.resource,
    expiresAt: now - 1,
  };
  store.save();
  const reloaded = new OAuthStore(stateFile, () => now);
  assert.equal(reloaded.state.clients[staleId], undefined);
  assert.equal(reloaded.state.accessTokens.expired, undefined);

  reloaded.state.clients = {};
  for (let i = 0; i < OAUTH_POLICY.maxRegisteredClients; i += 1) {
    const clientId = `cap-${i}`;
    reloaded.state.clients[clientId] = { clientId, createdAt: now };
  }
  assert.throws(
    () => reloaded.registerClient(registrationMetadata()),
    (error) => error?.status === 429 && error?.code === 'temporarily_unavailable',
  );
}

async function waitForLine(socket, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => cleanup(new Error('Timed out waiting for frame.')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (predicate(frame)) return cleanup(null, frame);
      }
    };
    const cleanup = (error, value) => {
      clearTimeout(timer);
      socket.off('data', onData);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on('data', onData);
  });
}

async function testWorkerHeartbeat() {
  const token = 't'.repeat(32);
  const device = { deviceId: 'local-test', name: 'local-test', enabled: true, local: true, token };
  const registry = { devices: [device], get: (id) => (id === device.deviceId ? device : null) };
  const logger = { log() {}, error() {} };
  const hub = new WorkerHub({
    registry,
    host: '127.0.0.1',
    port: 0,
    staleConnectionMs: 40,
    logger,
  });
  await hub.start();
  const port = hub.localServer.address().port;
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write(JSON.stringify({
    type: 'hello',
    deviceId: device.deviceId,
    name: device.name,
    token,
  }) + '\n');
  await waitForLine(socket, (frame) => frame.type === 'hello_ack');
  assert.ok(hub.connectionInfo(device.deviceId));
  await sleep(70);
  const closed = once(socket, 'close');
  hub.pingAll();
  await closed;
  await sleep(10);
  assert.equal(hub.connectionInfo(device.deviceId), null);
  await hub.stop();
}
function collectFrames(socket) {
  const frames = [];
  let buffer = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  return frames;
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition.');
}

async function testWorkerReconnectIsolation() {
  const fakeDc = path.join(tempRoot, 'fake-dc.mjs');
  fs.writeFileSync(fakeDc, `import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.id === undefined || message?.id === null) return;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) + '\\n');
  }, 120);
});
`, 'utf8');

  const connections = [];
  const server = net.createServer((socket) => {
    const frames = collectFrames(socket);
    connections.push({ socket, frames });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const envFile = path.join(tempRoot, 'agent.env');
  fs.writeFileSync(envFile, [
    'WC_DEVICE_ID=test-agent',
    'WC_DEVICE_NAME=test-agent',
    'WC_CONTROLLER_HOST=127.0.0.1',
    `WC_CONTROLLER_PORT=${port}`,
    `WC_DC_NODE=${process.execPath}`,
    `WC_DC_SCRIPT=${fakeDc}`,
    'WC_RECONNECT_MS=30',
  ].join('\n') + '\n', 'utf8');
  const agent = spawn(process.execPath, [path.join(rootDir, 'worker', 'agent.mjs'), envFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  agent.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  try {
    const first = await waitUntil(() => connections[0]);
    await waitUntil(() => first.frames.find((frame) => frame.type === 'hello'));
    first.socket.write(JSON.stringify({ type: 'hello_ack', deviceId: 'test-agent' }) + '\n');
    first.socket.write(JSON.stringify({
      type: 'request',
      requestId: 'old-request',
      payload: { jsonrpc: '2.0', id: 0, method: 'tools/call', params: {} },
    }) + '\n');
    await sleep(30);
    first.socket.destroy();
    const second = await waitUntil(() => connections[1]);
    await waitUntil(() => second.frames.find((frame) => frame.type === 'hello'));
    second.socket.write(JSON.stringify({ type: 'hello_ack', deviceId: 'test-agent' }) + '\n');
    await sleep(170);
    assert.equal(
      second.frames.some((frame) => frame.type === 'response' && frame.requestId === 'old-request'),
      false,
      'A response from the previous controller connection leaked into the new connection.',
    );
    second.socket.write(JSON.stringify({
      type: 'request',
      requestId: 'new-request',
      payload: { jsonrpc: '2.0', id: 0, method: 'tools/call', params: {} },
    }) + '\n');
    const fresh = await waitUntil(() =>
      second.frames.find((frame) => frame.type === 'response' && frame.requestId === 'new-request'),
    );
    assert.equal(fresh.message?.id, 0);
    assert.equal(fresh.message?.result?.ok, true);
  } finally {
    if (agent.exitCode === null) {
      const exited = once(agent, 'exit').catch(() => null);
      agent.kill();
      await Promise.race([exited, sleep(2000)]);
    }
    for (const { socket } of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  if (stderr.trim()) throw new Error('Worker test stderr: ' + stderr.trim());
}
async function main() {
  try {
    await testConfigAndOAuth();
    await testWorkerHeartbeat();
    await testWorkerReconnectIsolation();
    console.log('WCM self-contained tests: PASS');
    console.log('oauth_prune_and_cap=PASS');
    console.log('worker_heartbeat=PASS');
    console.log('worker_reconnect_isolation=PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('WCM self-contained tests: FAIL');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
