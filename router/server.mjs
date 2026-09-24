import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server as McpProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { loadDeviceRegistry } from './devices.mjs';
import { WorkerHub } from './worker-hub.mjs';
import {
  classifyToolResult,
  WCM_ERROR_SEMANTICS,
  WCM_TOOL_FAILURE_RULE,
} from './error-classification.mjs';
import { guardRouterToolResult, resolveMaxRouterToolResultBytes } from './response-guard.mjs';
import { ConnectionScopedToolListCache } from './tool-list-cache.mjs';
import { routerClientInfo, serverInfo } from './server-info.mjs';
import {
  stripDeviceRoutingArguments,
  withDeviceRoutingSchema,
} from './device-routing.mjs';
import { ApprovalTestManager } from './approval-test-manager.mjs';
import {
  APPROVAL_TEST_UI_URI,
  approvalTestRouterTools,
  localApprovalTestResource,
  mergeApprovalTestResourceList,
} from './approval-test-routing.mjs';

const ROUTER_HOST = process.env.WC_ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number(process.env.WC_ROUTER_PORT || 18009);
const WORKER_HOST = process.env.WC_WORKER_HOST || '127.0.0.1';
const WORKER_PORT = Number(process.env.WC_WORKER_PORT || 18101);
const WORKER_REMOTE_HOST = process.env.WC_WORKER_REMOTE_HOST || '';
const WORKER_REMOTE_PORT = Number(process.env.WC_WORKER_REMOTE_PORT || 18100);
const MCP_PATH = '/mcp';
const SDK_ALIAS_MCP_PATH = '/mcp-ccm';
const WORKER_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = resolveMaxRouterToolResultBytes(process.env.WC_MAX_TOOL_RESULT_BYTES);
const ROUTER_TRACE_FILE = path.resolve(process.cwd(), 'logs', 'router-trace.log');
const registry = loadDeviceRegistry(process.cwd());
const SPECIALIZED_CAPABILITIES = [
  'Bundled specialized capabilities (discoverability only; these are helper workflows, not standalone MCP actions):',
  '- Bilibili download: tools\\bilibili-download contains bridge.py for browser-side signed DASH metadata plus a bundled yt-dlp.exe fallback. For authenticated 1080P, prefer the documented BMG logged-in session -> playurl -> WCM/curl -> ffmpeg workflow.',
  '- Quark transfer: tools\\quark-transfer\\cloud-transfer.ps1 provides probe/upload commands and reuses the logged-in Windows Quark client for background uploads.',
  'When a request matches one of these capabilities, do not assume WCM lacks it. Read the README in that tool directory first, then use start_process and BMG where the documented workflow requires an authenticated browser session.',
].join('\n');
fs.mkdirSync(path.dirname(ROUTER_TRACE_FILE), { recursive: true });
function appendRouterTrace(level, message) {
  try { fs.appendFileSync(ROUTER_TRACE_FILE, `[${new Date().toISOString()}] ${level} ${message}\n`, 'utf8'); }
  catch {}
}
const routerLogger = {
  log: (...values) => appendRouterTrace('INFO', values.map(String).join(' ')),
  error: (...values) => appendRouterTrace('ERROR', values.map(String).join(' ')),
};
const approvalTestManager = new ApprovalTestManager({
  audit: (event) => appendRouterTrace('AUDIT', JSON.stringify(event)),
});
const hub = new WorkerHub({
  registry,
  host: WORKER_HOST,
  port: WORKER_PORT,
  remoteHost: WORKER_REMOTE_HOST,
  remotePort: WORKER_REMOTE_PORT,
  logger: routerLogger,
});
const sdkTransports = new Map();
const sdkServers = new Map();
const workerInitialization = new Map();
const toolListCache = new ConnectionScopedToolListCache();

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

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
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

function workerInitializePayload(sourcePayload = null) {
  const clientInfo = sourcePayload?.params?.clientInfo ||
    sourcePayload?.params?._meta?.['io.modelcontextprotocol/clientInfo'] ||
    routerClientInfo;
  return {
    jsonrpc: '2.0',
    id: 'worker-init-' + randomUUID(),
    method: 'initialize',
    params: {
      protocolVersion: WORKER_PROTOCOL_VERSION,
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
  const initialize = workerInitializePayload(sourcePayload);
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
  delete copy._meta;
  return copy;
}

function augmentTools(tools) {
  const routed = tools.map((tool) => {
    const baseTool = stripToolUiMetadata(tool);
    const inputSchema = withDeviceRoutingSchema(
      baseTool?.inputSchema,
      toolDeviceSchema(),
    );
    const capabilityHint = baseTool.name === 'start_process'
      ? `\n\n${SPECIALIZED_CAPABILITIES}`
      : '';
    const stabilityHint = baseTool.name === 'read_multiple_files'
      ? '\n\nMEDIA STABILITY: When reading images, use at most four image paths per call. For larger slide/image sets, inspect in batches or create a contact sheet with start_process.'
      : '';
    const description = typeof baseTool.description === 'string'
      ? `${baseTool.description}${capabilityHint}${stabilityHint}\n\n${WCM_TOOL_FAILURE_RULE}`
      : `${capabilityHint}${stabilityHint}\n\n${WCM_TOOL_FAILURE_RULE}`.trim();
    return { ...baseTool, description, inputSchema };
  });
  const plainAliases = [];
  const readFileTool = routed.find((tool) => tool?.name === 'read_file');
  if (readFileTool) {
    const alias = structuredClone(readFileTool);
    alias.name = 'read_file_plain';
    alias.description = `Read file contents without any embedded UI template metadata.\n\n${WCM_TOOL_FAILURE_RULE}`;
    delete alias._meta;
    plainAliases.push(alias);
  }
  return [
    {
      name: 'list_devices',
      description: `List Windows Console devices and their online status.\n\n${SPECIALIZED_CAPABILITIES}\n\n${WCM_ERROR_SEMANTICS}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ...plainAliases,
    ...routed,
  ];
}

function addApprovalTestTools(tools) {
  return [
    tools[0],
    ...approvalTestRouterTools(toolDeviceSchema()),
    ...tools.slice(1),
  ];
}

function toolResult(data, isError = false, context = {}) {
  return classifyToolResult({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    isError,
  }, context);
}

function structuredToolResult(data, { isError = false, meta = null, context = {} } = {}) {
  return classifyToolResult({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: data,
    ...(meta ? { _meta: meta } : {}),
    ...(isError ? { isError: true } : {}),
  }, context);
}

function approvalTestStatus(value) {
  return {
    wall_time_seconds: 0,
    kind: 'execution',
    environment_id: value?.device_id,
    ...value,
  };
}

function approvalTestPendingResult(value) {
  const structured = approvalTestStatus({
    ...value,
    output: 'Approval required. Present the WCM approval card before executing the frozen hostname action.',
  });
  return classifyToolResult({
    content: [{
      type: 'text',
      text: [
        'WCM froze a test command for approval.',
        'Approval ID: ' + structured.approval_id,
        'Operation ID: ' + structured.operation_id,
        'Device: ' + structured.device_id,
        'Command: ' + structured.command,
        'Expires: ' + structured.expires_at,
        'Call request_approval with this approval_id to render the approval card. Do not run the command yourself.',
      ].join('\n'),
    }],
    structuredContent: structured,
  });
}

function approvalTestCardResult(prepared) {
  const value = approvalTestStatus({
    ...prepared.request,
    output: 'Waiting for the user to approve or deny this frozen WCM test command.',
  });
  return classifyToolResult({
    content: [{
      type: 'text',
      text: [
        'WCM prepared a frozen test command for user approval.',
        'Approval ID: ' + value.approval_id,
        'Operation ID: ' + value.operation_id,
        'Device: ' + value.device_id,
        'Command: ' + value.command,
        'Expires: ' + value.expires_at,
        'The attached WCM approval test card is the only valid approval path for this request.',
        'Do not recreate or run this command yourself.',
      ].join('\n'),
    }],
    structuredContent: value,
    _meta: {
      source: 'wcm.approval',
      approval_nonce: prepared.approvalNonce,
    },
  });
}

function enforceToolResultSize(result, payload) {
  const guarded = guardRouterToolResult(result, MAX_TOOL_RESULT_BYTES);
  if (guarded.blocked) {
    const deviceId = payload?.params?.arguments?.deviceId || '-';
    const toolName = payload?.params?.name || '-';
    appendRouterTrace('WARN', `TOOL RESULT BLOCKED tool=${toolName} device=${deviceId} bytes=${guarded.responseBytes} limit=${MAX_TOOL_RESULT_BYTES}`);
  }
  return classifyToolResult(guarded.result);
}

async function listTools(sourcePayload = null, { includeApproval = true } = {}) {
  const deviceId = registry.defaultDeviceId;
  const connection = hub.connectionInfo(deviceId);
  if (!connection) throw new Error('Worker is offline: ' + deviceId);
  const cached = toolListCache.get(connection.connectionId);
  if (cached) {
    return includeApproval ? addApprovalTestTools(cached) : cached;
  }
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
  const tools = augmentTools(message.result.tools);
  const current = hub.connectionInfo(deviceId);
  if (!current) throw new Error('Worker disconnected during tools/list: ' + deviceId);
  const cachedTools = toolListCache.set(current.connectionId, tools);
  return includeApproval ? addApprovalTestTools(cachedTools) : cachedTools;
}

const RESOURCE_METHODS = new Set([
  'resources/list', 'resources/read', 'resources/templates/list',
]);

async function forwardDefaultResource(payload, sourcePayload = null) {
  const method = String(payload?.method || '');
  if (!RESOURCE_METHODS.has(method)) throw new Error('Unsupported resource method: ' + method);
  return callWorker(registry.defaultDeviceId, payload, sourcePayload);
}

async function routeResource(payload, sourcePayload = null, { includeApproval = true } = {}) {
  const method = String(payload?.method || '');
  const local = includeApproval ? localApprovalTestResource(payload) : null;
  if (local) {
    const bytes = Buffer.byteLength(local?.result?.contents?.[0]?.text || '', 'utf8');
    appendRouterTrace('UI', `resource_read uri=${APPROVAL_TEST_UI_URI} bytes=${bytes}`);
    return local;
  }
  const message = await forwardDefaultResource(payload, sourcePayload);
  if (message?.error) return message;
  if (method !== 'resources/list' || !includeApproval) return message;
  appendRouterTrace('UI', `resource_list include=${APPROVAL_TEST_UI_URI}`);
  return mergeApprovalTestResourceList(message);
}

function selectedToolDevice(payload) {
  const args = payload?.params?.arguments;
  const deviceId = args && typeof args === 'object' ? args.deviceId : null;
  const device = typeof deviceId === 'string' ? getDevice(deviceId) : null;
  return { args, deviceId, device };
}

function hostSessionFor(payload, sourcePayload = null) {
  const direct = payload?.params?._meta?.['openai/session'];
  if (direct != null && direct !== '') return String(direct);
  const source = sourcePayload?.params?._meta?.['openai/session'];
  return source == null || source === '' ? null : String(source);
}

function workerToolText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function approvalTestFailureState(error) {
  const text = String(error?.message || error || '');
  return /timed out|timeout/i.test(text) ? 'execution_unknown' : 'approved_retryable';
}

async function executeTool(payload, sourcePayload = null, { allowApproval = true } = {}) {
  const toolName = payload?.params?.name;
  if (toolName === 'list_devices') {
    return toolResult({
      defaultDeviceId: registry.defaultDeviceId,
      devices: hub.listStatus(),
    });
  }
  if (!allowApproval && ['approval_test_exec', 'request_approval', 'resolve_pending_action'].includes(toolName)) {
    return structuredToolResult({
      error: 'Approval-test tools are not available on the legacy MCP transport.',
    }, { isError: true });
  }
  if (toolName === 'approval_test_exec') {
    const args = payload?.params?.arguments || {};
    const device = typeof args.deviceId === 'string' ? getDevice(args.deviceId) : null;
    if (!device) {
      return structuredToolResult({
        error: args.deviceId
          ? 'Unknown or disabled deviceId: ' + args.deviceId
          : 'deviceId is required.',
        devices: hub.listStatus(),
      }, { isError: true });
    }
    try {
      const pending = approvalTestManager.request({
        deviceId: device.deviceId,
        justification: args.justification,
      });
      return approvalTestPendingResult({
        ...pending,
        output: 'Approval required. Call request_approval with this approval_id to display the WCM test approval card.',
      });
    } catch (error) {
      return structuredToolResult(
        { error: String(error?.message || error) },
        { isError: true },
      );
    }
  }
  if (toolName === 'request_approval') {
    const args = payload?.params?.arguments || {};
    try {
      const prepared = approvalTestManager.prepareAppApproval(args.approval_id, {
        hostSession: hostSessionFor(payload, sourcePayload),
      });
      return approvalTestCardResult(prepared);
    } catch (error) {
      return structuredToolResult(
        { error: String(error?.message || error) },
        { isError: true },
      );
    }
  }
  if (toolName === 'resolve_pending_action') {
    const args = payload?.params?.arguments || {};
    const hostSession = hostSessionFor(payload, sourcePayload);
    try {
      if (args.decision === 'deny') {
        const denied = approvalTestManager.deny(
          args.approval_id,
          args.approval_nonce,
          hostSession,
        );
        return structuredToolResult(approvalTestStatus({
          ...denied,
          output: 'The user denied the frozen WCM test command. It was not dispatched.',
        }));
      }
      if (args.decision !== 'approve') {
        throw new Error('decision must be approve or deny.');
      }
      const claimed = approvalTestManager.claim(
        args.approval_id,
        args.approval_nonce,
        hostSession,
      );
      const device = getDevice(claimed.action.deviceId);
      if (!device || !hub.connectionInfo(device.deviceId)) {
        const retryable = approvalTestManager.markRetryable(args.approval_id);
        return structuredToolResult(approvalTestStatus({
          ...retryable,
          output: 'The approved test command was not dispatched because the target worker is offline.',
        }));
      }
      const workerPayload = {
        jsonrpc: '2.0',
        id: 'approval-test-' + randomUUID(),
        method: 'tools/call',
        params: {
          name: 'start_process',
          arguments: {
            command: claimed.action.command,
            timeout_ms: claimed.action.timeoutMs,
            ...(claimed.action.shell ? { shell: claimed.action.shell } : {}),
          },
        },
      };
      try {
        const message = await callWorker(device.deviceId, workerPayload, sourcePayload);
        const consumed = approvalTestManager.markConsumed(args.approval_id);
        if (message.error) {
          return structuredToolResult(approvalTestStatus({
            ...consumed,
            action_failed: true,
            output: String(message.error?.message || JSON.stringify(message.error)),
          }));
        }
        const workerResult = message.result || {};
        return structuredToolResult(approvalTestStatus({
          ...consumed,
          output: workerToolText(workerResult) || 'Approved test command completed.',
        }));
      } catch (error) {
        const state = approvalTestFailureState(error);
        const transitioned = state === 'execution_unknown'
          ? approvalTestManager.markUnknown(args.approval_id)
          : approvalTestManager.markRetryable(args.approval_id);
        return structuredToolResult(approvalTestStatus({
          ...transitioned,
          output: String(error?.message || error),
        }));
      }
    } catch (error) {
      return structuredToolResult(
        { error: String(error?.message || error) },
        { isError: true },
      );
    }
  }
  const { args, deviceId, device } = selectedToolDevice(payload);
  if (!device) {
    const detail = deviceId ? 'Unknown or disabled deviceId: ' + deviceId : 'deviceId is required.';
    return toolResult({ error: detail, devices: hub.listStatus() }, true);
  }
  const forwarded = stripModernMeta(payload);
  forwarded.params = { ...(forwarded.params || {}) };
  if (forwarded.params.name === 'read_file_plain') forwarded.params.name = 'read_file';
  forwarded.params.arguments = stripDeviceRoutingArguments(args);
  forwarded.params.arguments = mapPathArguments(forwarded.params.arguments, device);
  try {
    const message = await callWorker(device.deviceId, forwarded, sourcePayload);
    if (message.error) {
      return toolResult(
        { deviceId: device.deviceId, upstreamError: message.error },
        true,
        { deviceOnline: Boolean(hub.connectionInfo(device.deviceId)) },
      );
    }
    return classifyToolResult(
      message.result || toolResult({ error: 'Worker returned no tool result.' }, true),
      { deviceOnline: Boolean(hub.connectionInfo(device.deviceId)) },
    );
  } catch (error) {
    return toolResult({
      deviceId: device.deviceId,
      error: String(error?.message || error),
    }, true, { deviceOnline: Boolean(hub.connectionInfo(device.deviceId)) });
  }
}

function sdkInstructions() {
  return `Every Desktop Commander tool requires an explicit deviceId. Ordinary WCM tools route directly to the selected worker and are not blocked by the approval test flow. approval_test_exec is an isolated test-only approval path for one frozen hostname action. Default device: ${registry.defaultDeviceId}.\n\n${SPECIALIZED_CAPABILITIES}\n\n${WCM_ERROR_SEMANTICS}`;
}

function unwrapRoutedResult(message, fallback) {
  if (message?.error) {
    throw new Error(String(message.error?.message || JSON.stringify(message.error)));
  }
  return message?.result || fallback;
}

function createSdkProtocolServer() {
  const protocolServer = new McpProtocolServer(serverInfo, {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
    instructions: sdkInstructions(),
  });

  const sdkEnvelope = (request) => ({
    jsonrpc: '2.0',
    id: 'sdk-' + randomUUID(),
    method: request.method,
    params: request.params || {},
  });

  protocolServer.setRequestHandler(ListToolsRequestSchema, async (request) => ({
    tools: await listTools(sdkEnvelope(request)),
  }));
  protocolServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const payload = sdkEnvelope(request);
    return enforceToolResultSize(await executeTool(payload, payload), payload);
  });
  protocolServer.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const payload = sdkEnvelope(request);
    return unwrapRoutedResult(await routeResource(payload, payload), { resources: [] });
  });
  protocolServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const payload = sdkEnvelope(request);
    return unwrapRoutedResult(await routeResource(payload, payload), { resourceTemplates: [] });
  });
  protocolServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const payload = sdkEnvelope(request);
    return unwrapRoutedResult(await routeResource(payload, payload), { contents: [] });
  });
  return protocolServer;
}

async function handleSdkMcp(request, response) {
  const sessionHeader = request.headers['mcp-session-id'];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader : null;
  let payload = null;
  if (request.method === 'POST') {
    const body = await readBody(request);
    try { payload = JSON.parse(body); }
    catch {
      sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error.'));
      return;
    }
  }

  let transport = sessionId ? sdkTransports.get(sessionId) : null;
  if (!transport) {
    if (request.method !== 'POST' || sessionId || !isInitializeRequest(payload)) {
      sendJson(response, 400, jsonRpcError(null, -32000, 'Missing or invalid MCP session.'));
      return;
    }
    const protocolServer = createSdkProtocolServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sdkTransports.set(newSessionId, transport);
        sdkServers.set(newSessionId, protocolServer);
        appendRouterTrace('SDK', `session_initialized id=${newSessionId}`);
      },
    });
    transport.onclose = async () => {
      const id = transport.sessionId;
      if (!id) return;
      sdkTransports.delete(id);
      const ownedServer = sdkServers.get(id);
      sdkServers.delete(id);
      if (ownedServer) await ownedServer.close().catch(() => {});
      appendRouterTrace('SDK', `session_closed id=${id}`);
    };
    await protocolServer.connect(transport);
  }

  await transport.handleRequest(request, response, payload);
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
  if (url.pathname !== MCP_PATH && url.pathname !== SDK_ALIAS_MCP_PATH) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, POST, DELETE');
    response.end();
    return;
  }
  await handleSdkMcp(request, response);
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
  for (const transport of sdkTransports.values()) {
    await transport.close().catch(() => {});
  }
  sdkTransports.clear();
  sdkServers.clear();
  await hub.stop();
  await new Promise((resolve) => server.close(() => resolve()));
}

process.on('SIGINT', () => stop().finally(() => process.exit()));
process.on('SIGTERM', () => stop().finally(() => process.exit()));

start().catch((error) => {
  console.error('Router startup failed:', error.message);
  process.exitCode = 1;
});
