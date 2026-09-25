import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import {
  ApprovalPolicyStore,
  DEFAULT_APPROVAL_DURATION_SECONDS,
  validateApprovalDurationSeconds,
} from './approval-policy.mjs';
import { approvalFailureState } from './approval-execution-state.mjs';
import { PendingActionManager } from './pending-action-manager.mjs';
import { TimedGrantManager } from './timed-grant-manager.mjs';
import {
  APPROVAL_UI_URI,
  approvalRouterTools,
  localApprovalResource,
} from './approval-routing.mjs';

const ROUTER_HOST = process.env.WC_ROUTER_HOST || '127.0.0.1';
const ROUTER_PORT = Number(process.env.WC_ROUTER_PORT || 18009);
const WORKER_HOST = process.env.WC_WORKER_HOST || '127.0.0.1';
const WORKER_PORT = Number(process.env.WC_WORKER_PORT || 18101);
const WORKER_REMOTE_HOST = process.env.WC_WORKER_REMOTE_HOST || '';
const WORKER_REMOTE_PORT = Number(process.env.WC_WORKER_REMOTE_PORT || 18100);
const MCP_PATH = '/mcp';
const WORKER_PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = resolveMaxRouterToolResultBytes(process.env.WC_MAX_TOOL_RESULT_BYTES);
const ROUTER_TRACE_FILE = path.resolve(process.cwd(), 'logs', 'router-trace.log');
const ROUTER_INSTANCE_ID = randomUUID();
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
routerLogger.log(`Router instance started instance=${ROUTER_INSTANCE_ID} pid=${process.pid}`);
function approvalAudit(event) {
  const approvalId = event?.approval_id;
  const safeEvent = { ...event };
  delete safeEvent.approval_id;
  appendRouterTrace('AUDIT', JSON.stringify({
    router_instance_id: ROUTER_INSTANCE_ID,
    approval_fingerprint: approvalId
      ? createHash('sha256').update(String(approvalId)).digest('hex').slice(0, 16)
      : null,
    ...safeEvent,
  }));
}
const approvalPolicyStore = new ApprovalPolicyStore({
  root: process.cwd(),
  logger: routerLogger,
});
const pendingActionManager = new PendingActionManager({
  audit: approvalAudit,
});
const timedGrantManager = new TimedGrantManager({
  audit: approvalAudit,
});
let approvalPolicy = approvalPolicyStore.current();

function refreshApprovalPolicy() {
  const previous = approvalPolicy;
  const refreshed = approvalPolicyStore.refresh();
  if (refreshed.changed) {
    approvalAudit({
      event: 'policy_changed',
      previous_mode: previous?.mode || null,
      previous_revision: previous?.revision ?? null,
      mode: refreshed.policy.mode,
      revision: refreshed.policy.revision,
      source: refreshed.source,
    });
    timedGrantManager.clearAll('policy_changed');
    pendingActionManager.clearPendingAll('policy_changed');
  }
  approvalPolicy = refreshed.policy;
  return approvalPolicy;
}

function approvalRuntimeSnapshot() {
  const policy = refreshApprovalPolicy();
  const pending = pendingActionManager.snapshot();
  const grants = timedGrantManager.snapshot();
  return {
    mode: policy.mode,
    policy_revision: policy.revision,
    default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
    ...pending,
    ...grants,
  };
}
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
  return [
    {
      name: 'list_devices',
      description: `List Windows Console devices and their online status.\n\n${SPECIALIZED_CAPABILITIES}\n\n${WCM_ERROR_SEMANTICS}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    ...routed,
  ];
}

function addApprovalTools(tools) {
  return [
    tools[0],
    ...approvalRouterTools(),
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

function grantFields(grant) {
  const active = grant?.grant_state === 'active';
  return {
    grant_active: active,
    grant_state: grant?.grant_state || null,
    grant_approval_id: grant?.approval_id || null,
    grant_granted_at: grant?.granted_at || null,
    grant_expires_at: grant?.expires_at || null,
    grant_remaining_seconds: grant?.remaining_seconds || 0,
    usable: active,
  };
}

function approvalStatus(value) {
  return {
    wall_time_seconds: 0,
    kind: 'approval',
    ...value,
  };
}

function approvalPendingResult(pending, requestedTool) {
  const structured = approvalStatus({
    classification: 'approval_required',
    approval_required: true,
    approval_id: pending.request.approval_id,
    operation_id: pending.request.operation_id,
    state: pending.request.state,
    owner: pending.owner,
    queued: false,
    device_id: requestedTool.deviceId,
    tool_name: requestedTool.toolName,
    action_summary: pending.request.action_summary,
    intent_sha256: pending.request.intent_sha256,
    created_at: pending.request.created_at,
    card_bound_at: pending.request.card_bound_at,
    card_expires_at: pending.request.card_expires_at,
    pending_expires_at: pending.request.pending_expires_at,
    terminal_reason: pending.request.terminal_reason,
    default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
    requested_duration_seconds: null,
    grant_scope: 'full_wcm',
    grant_effect: 'all_routed_tools_all_registered_devices',
    ...grantFields(null),
    action_state: null,
    action_failed: false,
    output:
      'Approval required. Call request_approval with this approval_id and optional duration_seconds. ' +
      'Do not recreate or execute the frozen owner action yourself.',
  });
  return structuredToolResult(structured);
}

function approvalCardResult(prepared) {
  const value = approvalStatus({
    classification: 'approval_pending_user',
    approval_required: true,
    ...prepared.request,
    owner: true,
    queued: false,
    default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
    grant_scope: 'full_wcm',
    grant_effect: 'all_routed_tools_all_registered_devices',
    ...grantFields(null),
    action_state: null,
    action_failed: false,
    output: 'Waiting for the user to approve or deny this timed WCM access request.',
  });
  return {
    content: [{
      type: 'text',
      text: [
        'WCM prepared a frozen owner action for user approval.',
        'Approval ID: ' + value.approval_id,
        'Device: ' + value.device_id,
        'Tool: ' + value.tool_name,
        'Requested duration: ' + value.requested_duration_seconds + ' seconds',
        'The attached WCM approval card is the only valid approval path for this request.',
      ].join('\n'),
    }],
    structuredContent: value,
    _meta: {
      source: 'wcm.approval',
      approval_nonce: prepared.approvalNonce,
    },
  };
}

function retainedApprovalResult(approvalId, error, {
  isRequestApproval = false,
} = {}) {
  const known = pendingActionManager.lookup(approvalId);
  if (!known) return null;
  const grant = timedGrantManager.inspect(approvalId);
  const state = known.state;
  const classification = state === 'pending' && isRequestApproval && known.card_bound_at
    ? 'approval_already_bound'
    : 'approval_' + state;
  let output = String(error?.message || error || '');
  if (state === 'expired') {
    output = 'This approval card expired before resolution. The frozen owner action was not dispatched.';
  } else if (state === 'superseded') {
    output = 'This approval was invalidated by a WCM approval-policy change. The frozen owner action was not dispatched.';
  } else if (state === 'consumed') {
    output = 'This approval was already consumed. The frozen owner action will not be dispatched again.';
  } else if (state === 'denied') {
    output = 'This approval was already denied. The frozen owner action was not dispatched.';
  } else if (state === 'pending' && known.card_bound_at && isRequestApproval) {
    output = 'Approval request is already bound to an approval card. Its nonce and requested grant duration are unchanged.';
  }
  return structuredToolResult(approvalStatus({
    classification,
    approval_required: state === 'pending',
    ...known,
    owner: true,
    queued: false,
    default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
    grant_scope: 'full_wcm',
    grant_effect: 'all_routed_tools_all_registered_devices',
    ...grantFields(grant),
    action_state: state === 'pending' ? null : state,
    action_failed: false,
    output,
  }), {
    isError: state === 'pending',
  });
}

function approvalIdStatusValue(approvalId) {
  const request = pendingActionManager.lookup(approvalId);
  const grant = timedGrantManager.inspect(approvalId);
  const grantActive = grant?.grant_state === 'active';
  let classification = 'approval_id_unknown';
  if (grantActive) classification = 'approval_id_active';
  else if (grant?.grant_state === 'expired') classification = 'approval_id_expired';
  else if (grant?.grant_state === 'revoked') classification = 'approval_id_revoked';
  else if (request?.state === 'pending' && request.card_bound_at) classification = 'approval_id_pending_bound';
  else if (request?.state === 'pending') classification = 'approval_id_pending_unbound';
  else if (request?.state) classification = 'approval_id_' + request.state;
  const output = grantActive
    ? 'This approval_id has an active timed full-WCM grant. Use call_with_approval to make authorized worker calls.'
    : classification === 'approval_id_unknown'
      ? 'Unknown approval_id. Call a normal WCM worker tool directly to create a fresh independent approval.'
      : 'This approval_id is not currently usable. Call a normal WCM worker tool directly to create a fresh independent approval.';
  return approvalStatus({
    classification,
    approval_required: request?.state === 'pending',
    approval_id: approvalId || null,
    operation_id: request?.operation_id || grant?.operation_id || null,
    state: request?.state || null,
    owner: true,
    queued: false,
    device_id: request?.device_id || null,
    tool_name: request?.tool_name || null,
    action_summary: request?.action_summary || null,
    intent_sha256: request?.intent_sha256 || null,
    created_at: request?.created_at || null,
    card_bound_at: request?.card_bound_at || null,
    card_expires_at: request?.card_expires_at || null,
    pending_expires_at: request?.pending_expires_at || null,
    terminal_reason: grant?.terminal_reason || request?.terminal_reason || null,
    default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
    requested_duration_seconds:
      grant?.requested_duration_seconds ?? request?.requested_duration_seconds ?? null,
    grant_scope: 'full_wcm',
    grant_effect: 'all_routed_tools_all_registered_devices',
    ...grantFields(grant),
    action_state: request?.state && request.state !== 'pending' ? request.state : null,
    action_failed: false,
    output,
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

async function routedToolsForDevice(deviceId, sourcePayload = null) {
  const connection = hub.connectionInfo(deviceId);
  if (!connection) throw new Error('Worker is offline: ' + deviceId);
  const cached = toolListCache.get(connection.connectionId);
  if (cached) return cached;
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
  return toolListCache.set(current.connectionId, tools);
}

async function listTools(sourcePayload = null) {
  const tools = await routedToolsForDevice(registry.defaultDeviceId, sourcePayload);
  return addApprovalTools(tools);
}

async function routeResource(payload) {
  const method = String(payload?.method || '');
  const local = localApprovalResource(payload);
  if (local) {
    if (method === 'resources/read' && local?.result?.contents?.[0]?.text) {
      const bytes = Buffer.byteLength(local.result.contents[0].text, 'utf8');
      appendRouterTrace('UI', `resource_read uri=${APPROVAL_UI_URI} bytes=${bytes}`);
    }
    return local;
  }
  throw new Error('Unsupported resource method: ' + method);
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

async function dispatchRoutedWorker({
  device,
  toolName,
  workerArguments,
  sourcePayload = null,
  requestIdPrefix = 'router',
}) {
  const workerPayload = {
    jsonrpc: '2.0',
    id: requestIdPrefix + '-' + randomUUID(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: mapPathArguments(workerArguments || {}, device),
    },
  };
  try {
    const message = await callWorker(device.deviceId, workerPayload, sourcePayload);
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

async function assertRealWorkerTool(deviceId, toolName, sourcePayload = null) {
  const tools = await routedToolsForDevice(deviceId, sourcePayload);
  const found = tools.find((tool) => tool.name === toolName && tool.name !== 'list_devices');
  if (!found) throw new Error('Unknown or Router-local tool_name: ' + toolName);
  return found;
}

async function executeTool(payload, sourcePayload = null) {
  const toolName = payload?.params?.name;

  if (toolName === 'list_devices') {
    return toolResult({
      defaultDeviceId: registry.defaultDeviceId,
      devices: hub.listStatus(),
      approval: approvalRuntimeSnapshot(),
    });
  }

  if (toolName === 'approval_status') {
    const args = payload?.params?.arguments || {};
    refreshApprovalPolicy();
    return structuredToolResult(approvalIdStatusValue(args.approval_id));
  }

  if (toolName === 'call_with_approval') {
    const args = payload?.params?.arguments || {};
    const device = typeof args.deviceId === 'string' ? getDevice(args.deviceId) : null;
    if (!device) {
      const detail = args.deviceId
        ? 'Unknown or disabled deviceId: ' + args.deviceId
        : 'deviceId is required.';
      return toolResult({ error: detail, devices: hub.listStatus() }, true);
    }
    if (typeof args.tool_name !== 'string' || !args.tool_name) {
      return toolResult({ error: 'tool_name is required.' }, true);
    }
    if (args.arguments != null && (typeof args.arguments !== 'object' || Array.isArray(args.arguments))) {
      return toolResult({ error: 'arguments must be an object.' }, true);
    }
    try {
      await assertRealWorkerTool(device.deviceId, args.tool_name, sourcePayload);
    } catch (error) {
      return toolResult({ error: String(error?.message || error) }, true);
    }
    const policy = refreshApprovalPolicy();
    if (policy.mode === 'timed') {
      const grant = timedGrantManager.active(args.approval_id);
      if (!grant) {
        return structuredToolResult(approvalIdStatusValue(args.approval_id), { isError: true });
      }
    }
    return dispatchRoutedWorker({
      device,
      toolName: args.tool_name,
      workerArguments: args.arguments || {},
      sourcePayload,
      requestIdPrefix: 'grant',
    });
  }

  if (toolName === 'request_approval') {
    const args = payload?.params?.arguments || {};
    try {
      const policy = refreshApprovalPolicy();
      if (policy.mode !== 'timed') {
        throw new Error('WCM approval mode is off; no approval request is active.');
      }
      const requestedDurationSeconds = validateApprovalDurationSeconds(args.duration_seconds);
      const prepared = pendingActionManager.prepareAppApproval(args.approval_id, {
        hostSession: hostSessionFor(payload, sourcePayload),
        requestedDurationSeconds,
      });
      return approvalCardResult(prepared);
    } catch (error) {
      const retained = retainedApprovalResult(args.approval_id, error, {
        isRequestApproval: true,
      });
      if (retained) return retained;
      return structuredToolResult(approvalStatus({
        classification: 'approval_error',
        approval_required: false,
        approval_id: args.approval_id || null,
        operation_id: null,
        state: null,
        owner: true,
        queued: false,
        device_id: null,
        tool_name: null,
        action_summary: null,
        intent_sha256: null,
        created_at: null,
        card_bound_at: null,
        card_expires_at: null,
        pending_expires_at: null,
        terminal_reason: null,
        default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
        requested_duration_seconds: null,
        grant_scope: 'full_wcm',
        grant_effect: 'all_routed_tools_all_registered_devices',
        ...grantFields(timedGrantManager.inspect(args.approval_id)),
        action_state: null,
        action_failed: false,
        output: String(error?.message || error),
      }), { isError: true });
    }
  }

  if (toolName === 'resolve_pending_action') {
    const args = payload?.params?.arguments || {};
    const hostSession = hostSessionFor(payload, sourcePayload);
    try {
      const policy = refreshApprovalPolicy();
      if (args.decision === 'deny') {
        const denied = pendingActionManager.deny(
          args.approval_id,
          args.approval_nonce,
          hostSession,
        );
        return structuredToolResult(approvalStatus({
          classification: 'approval_denied',
          approval_required: false,
          ...denied,
          owner: true,
          queued: false,
          default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
          grant_scope: 'full_wcm',
          grant_effect: 'all_routed_tools_all_registered_devices',
          ...grantFields(null),
          action_state: 'denied',
          action_failed: false,
          output: 'The user denied the frozen WCM owner action. It was not dispatched.',
        }));
      }
      if (args.decision !== 'approve') {
        throw new Error('decision must be approve or deny.');
      }
      if (policy.mode !== 'timed') {
        throw new Error('WCM approval mode changed before this request was approved.');
      }

      const claimed = pendingActionManager.claim(
        args.approval_id,
        args.approval_nonce,
        hostSession,
      );
      const grant = timedGrantManager.grant({
        approvalId: args.approval_id,
        requestedDurationSeconds: claimed.requestedDurationSeconds,
        operationId: claimed.request.operation_id,
        policyRevision: policy.revision,
      });
      const base = {
        classification: 'approval_resolved',
        approval_required: false,
        ...claimed.request,
        owner: true,
        queued: false,
        default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
        requested_duration_seconds: claimed.requestedDurationSeconds,
        grant_scope: 'full_wcm',
        grant_effect: 'all_routed_tools_all_registered_devices',
        ...grantFields(grant),
      };

      const device = getDevice(claimed.action.deviceId);
      if (!device || !hub.connectionInfo(device.deviceId)) {
        const retryable = pendingActionManager.markRetryable(args.approval_id);
        return structuredToolResult(approvalStatus({
          ...base,
          ...retryable,
          action_state: 'approved_retryable',
          action_failed: false,
          output: 'The owner action was not dispatched because the target worker is offline. The timed WCM grant is active. Use call_with_approval with this approval_id for later WCM calls.',
        }));
      }

      const workerPayload = {
        jsonrpc: '2.0',
        id: 'approval-' + randomUUID(),
        method: 'tools/call',
        params: {
          name: claimed.action.toolName,
          arguments: claimed.action.workerArguments,
        },
      };

      try {
        const message = await callWorker(device.deviceId, workerPayload, sourcePayload);
        const consumed = pendingActionManager.markConsumed(args.approval_id);
        if (message.error) {
          return structuredToolResult(approvalStatus({
            ...base,
            ...consumed,
            action_state: 'consumed',
            action_failed: true,
          output: String(message.error?.message || JSON.stringify(message.error)) +
            ' The timed WCM grant is active; use call_with_approval with this approval_id for later WCM calls.',
          }));
        }
        const workerResult = message.result || {};
        return structuredToolResult(approvalStatus({
          ...base,
          ...consumed,
          action_state: 'consumed',
          action_failed: false,
          output: (workerToolText(workerResult) || 'Approved owner action completed.') +
            ' Use call_with_approval with this approval_id for later WCM calls. Call a normal WCM tool directly to request another independent grant.',
        }));
      } catch (error) {
        const state = approvalFailureState(error);
        const transitioned = state === 'execution_unknown'
          ? pendingActionManager.markUnknown(args.approval_id)
          : pendingActionManager.markRetryable(args.approval_id);
        return structuredToolResult(approvalStatus({
          ...base,
          ...transitioned,
          action_state: state,
          action_failed: false,
          output: String(error?.message || error) +
            ' The timed WCM grant is active; use call_with_approval with this approval_id for later WCM calls.',
        }));
      }
    } catch (error) {
      const retained = retainedApprovalResult(args.approval_id, error);
      if (retained) return retained;
      return structuredToolResult(approvalStatus({
        classification: 'approval_error',
        approval_required: false,
        approval_id: args.approval_id || null,
        operation_id: null,
        state: null,
        owner: true,
        queued: false,
        device_id: null,
        tool_name: null,
        action_summary: null,
        intent_sha256: null,
        created_at: null,
        card_bound_at: null,
        card_expires_at: null,
        pending_expires_at: null,
        terminal_reason: null,
        default_duration_seconds: DEFAULT_APPROVAL_DURATION_SECONDS,
        requested_duration_seconds: null,
        grant_scope: 'full_wcm',
        grant_effect: 'all_routed_tools_all_registered_devices',
        ...grantFields(timedGrantManager.inspect(args.approval_id)),
        action_state: null,
        action_failed: false,
        output: String(error?.message || error),
      }), { isError: true });
    }
  }

  const { args, deviceId, device } = selectedToolDevice(payload);
  if (!device) {
    const detail = deviceId ? 'Unknown or disabled deviceId: ' + deviceId : 'deviceId is required.';
    return toolResult({ error: detail, devices: hub.listStatus() }, true);
  }

  const policy = refreshApprovalPolicy();
  const workerArguments = mapPathArguments(stripDeviceRoutingArguments(args), device);
  if (policy.mode === 'timed') {
    const pending = pendingActionManager.ensurePending({
      deviceId: device.deviceId,
      toolName,
      workerArguments,
      summary: toolName + ' on ' + device.deviceId,
    });
    return approvalPendingResult(pending, {
      deviceId: device.deviceId,
      toolName,
    });
  }
  return dispatchRoutedWorker({
    device,
    toolName,
    workerArguments: stripDeviceRoutingArguments(args),
    sourcePayload,
    requestIdPrefix: 'direct',
  });
}
function sdkInstructions() {
  return `Every Desktop Commander tool requires an explicit deviceId. WCM approval mode is controlled locally. In timed mode, every normal routed worker-tool call is frozen independently and returns approval_required=true with a fresh approval_id; call request_approval with that approval_id and an optional duration_seconds (default 21600). After approval, reuse that exact timed full-WCM grant through call_with_approval. Calling a normal worker tool directly always requests another independent approval. Multiple approval IDs can remain active concurrently. In off mode, routed tools and call_with_approval execute directly. list_devices reports only aggregate approval counts; approval_status performs point lookup for an ID you already possess. Default device: ${registry.defaultDeviceId}.\n\n${SPECIALIZED_CAPABILITIES}\n\n${WCM_ERROR_SEMANTICS}`;
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
  if (url.pathname !== MCP_PATH) {
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
