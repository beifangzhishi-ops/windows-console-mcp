import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDeviceRegistry } from './devices.mjs';
import { WorkerHub } from './worker-hub.mjs';

const ROUTER_HOST = process.env.WC_ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number(process.env.WC_ROUTER_PORT || 18009);
const WORKER_HOST = process.env.WC_WORKER_HOST || '127.0.0.1';
const WORKER_PORT = Number(process.env.WC_WORKER_PORT || 18101);
const WORKER_REMOTE_HOST = process.env.WC_WORKER_REMOTE_HOST || '';
const WORKER_REMOTE_PORT = Number(process.env.WC_WORKER_REMOTE_PORT || 18100);
const MCP_PATH = '/mcp';
const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;
const ROUTER_TRACE_FILE = path.resolve(process.cwd(), 'logs', 'router-trace.log');
const registry = loadDeviceRegistry(process.cwd());
const serverInfo = { name: 'windows-console-mcp', version: '1.1.2' };
fs.mkdirSync(path.dirname(ROUTER_TRACE_FILE), { recursive: true });
function appendRouterTrace(level, message) {
  try { fs.appendFileSync(ROUTER_TRACE_FILE, `[${new Date().toISOString()}] ${level} ${message}\n`, 'utf8'); }
  catch {}
}
const routerLogger = {
  log: (...values) => appendRouterTrace('INFO', values.map(String).join(' ')),
  error: (...values) => appendRouterTrace('ERROR', values.map(String).join(' ')),
};
const hub = new WorkerHub({
  registry,
  host: WORKER_HOST,
  port: WORKER_PORT,
  remoteHost: WORKER_REMOTE_HOST,
  remotePort: WORKER_REMOTE_PORT,
  logger: routerLogger,
});
const legacySessions = new Map();
const workerInitialization = new Map();

function enabledDevices() {
  return registry.devices.filter((device) => device.enabled);
}

function getDevice(deviceId) {
  return registry.get(deviceId);
}
function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(text));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(text);
}

function sendSse(response, status, message, sessionId = null) {
  const text = 'event: message\ndata: ' + JSON.stringify(message) + '\n\n';
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (sessionId) response.setHeader('Mcp-Session-Id', sessionId);
  response.end(text);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function modernResult(result) {
  return {
    resultType: 'complete',
    ...result,
    _meta: {
      ...(result?._meta || {}),
      'io.modelcontextprotocol/serverInfo': serverInfo,
    },
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function stripModernMeta(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = structuredClone(payload);
  if (copy.params && typeof copy.params === 'object') delete copy.params._meta;
  return copy;
}

function legacyInitializePayload(sourcePayload = null) {
  const clientInfo = sourcePayload?.params?.clientInfo ||
    sourcePayload?.params?._meta?.['io.modelcontextprotocol/clientInfo'] ||
    { name: 'windows-console-router', version: '1.1.2' };
  return {
    jsonrpc: '2.0',
    id: 'worker-init-' + randomUUID(),
    method: 'initialize',
    params: {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: {},
      clientInfo,
    },
  };
}

async function ensureWorkerInitialized(deviceId, sourcePayload = null) {
  const info = hub.connectionInfo(deviceId);
  if (!info) throw new Error('Worker is offline: ' + deviceId);
  const cached = workerInitialization.get(deviceId);
  if (cached?.connectionId === info.connectionId) return cached;
  const initialize = legacyInitializePayload(sourcePayload);
  const message = await hub.call(deviceId, initialize);
  if (!message?.result) throw new Error('Worker initialize failed: ' + deviceId);
  hub.notify(deviceId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
  const state = {
    connectionId: info.connectionId,
    initializeResult: message.result,
  };
  workerInitialization.set(deviceId, state);
  return state;
}

async function callWorker(deviceId, payload, sourcePayload = null) {
  await ensureWorkerInitialized(deviceId, sourcePayload);
  const message = await hub.call(deviceId, stripModernMeta(payload));
  if (!message || typeof message !== 'object') {
    throw new Error('Worker returned an invalid JSON-RPC response: ' + deviceId);
  }
  return message;
}

function toolDeviceSchema() {
  return {
    type: 'string',
    enum: enabledDevices().map((device) => device.deviceId),
    description: 'Target device. Required for every Desktop Commander tool call.',
  };
}

const PATH_ARGUMENT_KEYS = new Set([
  'path', 'paths', 'source', 'destination', 'outputPath', 'file_path', 'sourcePdfPath',
]);

function mapDevicePath(value, device) {
  if (typeof value !== 'string' || !Array.isArray(device?.pathMappings)) return value;
  for (const mapping of device.pathMappings) {
    const drive = String(mapping.from || '').slice(0, 2).toLowerCase();
    if (value.slice(0, 2).toLowerCase() !== drive) continue;
    if (value.length > 2 && value[2] !== '\\' && value[2] !== '/') continue;
    const remainder = value.slice(2).replace(/^[\\/]+/u, '').replace(/\\/gu, '/');
    const base = mapping.to === '/' ? '' : String(mapping.to || '').replace(/\/+$/u, '');
    return remainder ? base + '/' + remainder : (base || '/');
  }
  return value;
}

function mapPathArguments(value, device) {
  if (Array.isArray(value)) return value.map((item) => mapPathArguments(item, device));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (PATH_ARGUMENT_KEYS.has(key)) {
      if (typeof child === 'string') copy[key] = mapDevicePath(child, device);
      else if (Array.isArray(child)) {
        copy[key] = child.map((item) => typeof item === 'string'
          ? mapDevicePath(item, device)
          : mapPathArguments(item, device));
      } else copy[key] = mapPathArguments(child, device);
    } else copy[key] = mapPathArguments(child, device);
  }
  return copy;
}

function stripToolUiMetadata(tool) {
  const copy = { ...tool };
  if (!copy._meta || typeof copy._meta !== 'object') return copy;
  const meta = structuredClone(copy._meta);
  delete meta['openai/outputTemplate'];
  delete meta['ui/resourceUri'];
  delete meta.ui;
  delete meta['openai/widgetAccessible'];
  if (Object.keys(meta).length > 0) copy._meta = meta;
  else delete copy._meta;
  return copy;
}

function augmentTools(tools) {
  const routed = tools.map((tool) => {
    const baseTool = stripToolUiMetadata(tool);
    const inputSchema = baseTool?.inputSchema && typeof baseTool.inputSchema === 'object'
      ? structuredClone(baseTool.inputSchema)
      : { type: 'object', properties: {} };
    inputSchema.type = 'object';
    inputSchema.properties = {
      ...(inputSchema.properties || {}),
      deviceId: toolDeviceSchema(),
    };
    inputSchema.required = Array.from(new Set([...(inputSchema.required || []), 'deviceId']));
    return { ...baseTool, inputSchema };
  });
  const plainAliases = [];
  const readFileTool = routed.find((tool) => tool?.name === 'read_file');
  if (readFileTool) {
    const alias = structuredClone(readFileTool);
    alias.name = 'read_file_plain';
    alias.description = 'Read file contents without any embedded UI template metadata.';
    delete alias._meta;
    plainAliases.push(alias);
  }
  return [
    {
      name: 'list_devices',
      description: 'List Windows Console devices and their online status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ...plainAliases,
    ...routed,
  ];
}

function toolResult(data, isError = false) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    isError,
  };
}

async function listTools(sourcePayload = null) {
  const deviceId = registry.defaultDeviceId;
  const payload = {
    jsonrpc: '2.0',
    id: 'worker-tools-' + randomUUID(),
    method: 'tools/list',
    params: {},
  };
  const message = await callWorker(deviceId, payload, sourcePayload);
  if (!Array.isArray(message?.result?.tools)) {
    throw new Error('Default worker tools/list failed: ' + deviceId);
  }
  return augmentTools(message.result.tools);
}

const RESOURCE_METHODS = new Set([
  'resources/list', 'resources/read', 'resources/templates/list',
]);

async function forwardDefaultResource(payload, sourcePayload = null) {
  const method = String(payload?.method || '');
  if (!RESOURCE_METHODS.has(method)) throw new Error('Unsupported resource method: ' + method);
  return callWorker(registry.defaultDeviceId, payload, sourcePayload);
}

function selectedToolDevice(payload) {
  const args = payload?.params?.arguments;
  const deviceId = args && typeof args === 'object' ? args.deviceId : null;
  const device = typeof deviceId === 'string' ? getDevice(deviceId) : null;
  return { args, deviceId, device };
}

async function executeTool(payload, sourcePayload = null) {
  if (payload?.params?.name === 'list_devices') {
    return toolResult({
      defaultDeviceId: registry.defaultDeviceId,
      devices: hub.listStatus(),
    });
  }
  const { args, deviceId, device } = selectedToolDevice(payload);
  if (!device) {
    const detail = deviceId ? 'Unknown or disabled deviceId: ' + deviceId : 'deviceId is required.';
    return toolResult({ error: detail, devices: hub.listStatus() }, true);
  }
  const forwarded = stripModernMeta(payload);
  forwarded.params = { ...(forwarded.params || {}) };
  if (forwarded.params.name === 'read_file_plain') forwarded.params.name = 'read_file';
  forwarded.params.arguments = { ...(args || {}) };
  delete forwarded.params.arguments.deviceId;
  forwarded.params.arguments = mapPathArguments(forwarded.params.arguments, device);
  try {
    const message = await callWorker(device.deviceId, forwarded, sourcePayload);
    if (message.error) {
      return toolResult({ deviceId: device.deviceId, upstreamError: message.error }, true);
    }
    return message.result || toolResult({ error: 'Worker returned no tool result.' }, true);
  } catch (error) {
    return toolResult({
      deviceId: device.deviceId,
      error: String(error?.message || error),
    }, true);
  }
}

function modernDiscovery(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: modernResult({
      supportedVersions: [MODERN_PROTOCOL],
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: 'Call list_devices first. Every Desktop Commander tool requires an explicit deviceId.',
      ttlMs: 5000,
      cacheScope: 'private',
    }),
  };
}

async function handleModern(payload, response) {
  const id = payload?.id ?? null;
  if (payload?.method === 'server/discover') {
    sendJson(response, 200, modernDiscovery(id));
    return;
  }
  if (RESOURCE_METHODS.has(payload?.method)) {
    const message = await forwardDefaultResource(payload, payload);
    const envelope = message.error
      ? { jsonrpc: '2.0', id, error: message.error }
      : { jsonrpc: '2.0', id, result: message.result || {} };
    sendJson(response, 200, envelope);
    return;
  }
  if (payload?.method === 'tools/list') {
    const tools = await listTools(payload);
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id,
      result: { tools },
    });
    return;
  }
  if (payload?.method === 'tools/call') {
    const result = await executeTool(payload, payload);
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id,
      result,
    });
    return;
  }
  if (payload?.method === 'ping') {
    sendJson(response, 200, {
      jsonrpc: '2.0', id, result: {},
    });
    return;
  }
  if (payload?.id === undefined || payload?.id === null) {
    response.statusCode = 202;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
    return;
  }
  sendJson(
    response,
    200,
    jsonRpcError(id, -32601, 'Method not found: ' + String(payload?.method || 'unknown')),
  );
}

function legacyInitializeResult(payload) {
  return {
    jsonrpc: '2.0',
    id: payload.id,
    result: {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: { tools: { listChanged: true }, resources: {} },
      serverInfo,
    },
  };
}
async function handleLegacy(payload, request, response) {
  if (payload?.method === 'initialize') {
    const sessionId = randomUUID();
    legacySessions.set(sessionId, {
      createdAt: Date.now(),
      initializePayload: payload,
      toolsListChangedSent: false,
    });
    sendSse(response, 200, legacyInitializeResult(payload), sessionId);
    return;
  }
  const sessionId = request.headers['mcp-session-id'];
  const session = typeof sessionId === 'string' ? legacySessions.get(sessionId) : null;
  if (!session) {
    sendJson(response, 400, { error: 'invalid_session', message: 'Invalid or missing session ID.' });
    return;
  }
  if (payload?.method === 'notifications/initialized') {
    response.statusCode = 202;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
    return;
  }
  if (RESOURCE_METHODS.has(payload?.method)) {
    const message = await forwardDefaultResource(payload, session.initializePayload);
    const envelope = message.error
      ? { jsonrpc: '2.0', id: payload.id, error: message.error }
      : { jsonrpc: '2.0', id: payload.id, result: message.result || {} };
    sendSse(response, 200, envelope, sessionId);
    return;
  }
  if (payload?.method === 'tools/list') {
    const tools = await listTools(session.initializePayload);
    sendSse(response, 200, {
      jsonrpc: '2.0', id: payload.id, result: { tools },
    }, sessionId);
    return;
  }
  if (payload?.method === 'tools/call') {
    const result = await executeTool(payload, session.initializePayload);
    sendSse(response, 200, {
      jsonrpc: '2.0', id: payload.id, result,
    }, sessionId);
    return;
  }
  if (payload?.method === 'ping') {
    sendSse(response, 200, {
      jsonrpc: '2.0', id: payload.id, result: {},
    }, sessionId);
    return;
  }
  if (payload?.id === undefined || payload?.id === null) {
    response.statusCode = 202;
    response.end();
    return;
  }
  sendSse(
    response,
    200,
    jsonRpcError(payload.id, -32601, 'Method not found: ' + String(payload.method)),
    sessionId,
  );
}

function handleLegacyStream(request, response) {
  const sessionId = request.headers['mcp-session-id'];
  const session = typeof sessionId === 'string' ? legacySessions.get(sessionId) : null;
  if (!session) {
    sendJson(response, 400, { error: 'invalid_session' });
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('Mcp-Session-Id', sessionId);
  response.write(': connected\n\n');
  if (!session.toolsListChangedSent) {
    response.write(
      'event: message\ndata: ' + JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      }) + '\n\n',
    );
    session.toolsListChangedSent = true;
  }
  const timer = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive\n\n');
  }, 15000);
  response.on('close', () => clearInterval(timer));
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, {
      status: 'ok',
      service: 'windows-console-router',
      defaultDeviceId: registry.defaultDeviceId,
      devices: hub.listStatus(),
    });
    return;
  }
  if (url.pathname !== MCP_PATH) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }
  if (request.method === 'GET') {
    handleLegacyStream(request, response);
    return;
  }
  if (request.method === 'DELETE') {
    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string') legacySessions.delete(sessionId);
    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, POST, DELETE');
    response.end();
    return;
  }
  const body = await readBody(request);
  let payload;
  try { payload = JSON.parse(body); }
  catch {
    sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error.'));
    return;
  }
  const protocol = String(request.headers['mcp-protocol-version'] || '');
  if (protocol === MODERN_PROTOCOL || payload?.method === 'server/discover') {
    await handleModern(payload, response);
    return;
  }
  await handleLegacy(payload, request, response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: 'router_error',
        message: String(error?.message || error),
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

let pingTimer = null;
let stopping = false;

async function start() {
  await hub.start();
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(ROUTER_PORT, ROUTER_HOST);
  });
  pingTimer = setInterval(() => hub.pingAll(), 15000);
  console.log('Windows Console router listening on ' + ROUTER_HOST + ':' + ROUTER_PORT + '.');
  console.log('Worker hub listening on ' + WORKER_HOST + ':' + WORKER_PORT + '.');
}

async function stop() {
  if (stopping) return;
  stopping = true;
  if (pingTimer) clearInterval(pingTimer);
  await hub.stop();
  await new Promise((resolve) => server.close(() => resolve()));
}

process.on('SIGINT', () => stop().finally(() => process.exit()));
process.on('SIGTERM', () => stop().finally(() => process.exit()));

start().catch((error) => {
  console.error('Router startup failed:', error.message);
  process.exitCode = 1;
});
