import './style.css';

type ApprovalResult = {
  approval_id?: string;
  operation_id?: string;
  state?: string;
  device_id?: string;
  command?: string;
  justification?: string;
  expires_at?: string;
  output?: string;
  action_failed?: boolean;
};

type ToolResult = {
  structuredContent?: ApprovalResult;
  _meta?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type OpenAIHost = {
  toolResponseMetadata?: {
    mcp_tool_result?: ToolResult;
    call_tool_result?: ToolResult;
  };
  toolOutput?: ApprovalResult;
  notifyIntrinsicHeight?: () => void;
  sendFollowUpMessage?: (input: {
    prompt: string;
    scrollToBottom?: boolean;
  }) => Promise<unknown>;
};

declare global {
  interface Window {
    openai?: OpenAIHost;
  }
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PROTOCOL_VERSION = '2026-01-26';
const pending = new Map<number, PendingRequest>();
let nextId = 1;

const status = document.querySelector<HTMLElement>('#status')!;
const details = document.querySelector<HTMLElement>('#details')!;
const device = document.querySelector<HTMLElement>('#device')!;
const approvalId = document.querySelector<HTMLElement>('#approval-id')!;
const expires = document.querySelector<HTMLElement>('#expires')!;
const host = document.querySelector<HTMLElement>('#host')!;
const justification = document.querySelector<HTMLElement>('#justification')!;
const command = document.querySelector<HTMLElement>('#command')!;
const approve = document.querySelector<HTMLButtonElement>('#approve')!;
const deny = document.querySelector<HTMLButtonElement>('#deny')!;

let approval: ApprovalResult | null = null;
let approvalNonce: string | null = null;
let busy = false;

function post(message: unknown) {
  window.parent.postMessage(message, '*');
}

function request<T = any>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    post({ jsonrpc: '2.0', id, method, params });
  });
}

function toolEnvelope(): ToolResult | null {
  const metadata = window.openai?.toolResponseMetadata;
  return metadata?.mcp_tool_result || metadata?.call_tool_result || null;
}

function updateHeight() {
  try {
    window.openai?.notifyIntrinsicHeight?.();
  } catch {}
}

function setStatus(message: string, isError = false) {
  status.textContent = message;
  status.dataset.error = isError ? 'true' : 'false';
  updateHeight();
}

function canDecide() {
  return approval?.state === 'pending' || approval?.state === 'approved_retryable';
}

function setBusy(value: boolean) {
  busy = value;
  const enabled = !value && canDecide() && Boolean(approval?.approval_id && approvalNonce);
  approve.disabled = !enabled;
  deny.disabled = !enabled;
  updateHeight();
}

function toolText(result: ToolResult | null | undefined) {
  return Array.isArray(result?.content)
    ? result.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
    : '';
}

function renderApproval() {
  if (!approval?.approval_id) return false;
  device.textContent = approval.device_id || 'Unknown';
  approvalId.textContent = approval.approval_id;
  expires.textContent = approval.expires_at || '';
  host.textContent = window.openai ? 'ChatGPT' : 'MCP Apps host';
  justification.textContent = approval.justification || 'Approve the fixed read-only hostname test?';
  command.textContent = approval.command || 'hostname';
  details.hidden = false;
  updateHeight();
  return true;
}

function readInitialResult(result: ToolResult | null = null) {
  const envelope = result || toolEnvelope();
  const structured = envelope?.structuredContent || window.openai?.toolOutput || null;
  const hidden = envelope?._meta || {};
  if (!structured) return false;

  approval = { ...(approval || {}), ...structured };
  approvalNonce = typeof hidden.approval_nonce === 'string' ? hidden.approval_nonce : null;
  if (!renderApproval()) return false;

  if (!approvalNonce && canDecide()) {
    setStatus('Approval token is unavailable in this host.', true);
  } else if (approval.state === 'pending') {
    setStatus('Connected. Waiting for your decision.');
  } else {
    setStatus(
      approval.output || toolText(envelope) || `State: ${approval.state || 'unknown'}`,
      Boolean(approval.action_failed),
    );
  }
  setBusy(false);
  return true;
}

function resultSummary(result: ApprovalResult, decision: 'approve' | 'deny') {
  return {
    source: 'wcm.approval-test',
    decision,
    approval_id: result.approval_id,
    operation_id: result.operation_id,
    state: result.state,
    device_id: result.device_id,
    action_failed: result.action_failed,
    output: typeof result.output === 'string' ? result.output.slice(0, 12000) : '',
  };
}

async function notifyModel(decision: 'approve' | 'deny', result: ApprovalResult) {
  const text = decision === 'deny'
    ? 'The user denied the frozen WCM approval test action. Do not execute it.'
    : 'The user approved the frozen WCM approval test action. WCM already handled the frozen action; do not recreate or rerun it.';
  try {
    await request('ui/update-model-context', {
      content: [{ type: 'text', text }],
      structuredContent: resultSummary(result, decision),
    }, 10000);
  } catch {}

  const openai = window.openai;
  if (!openai || typeof openai.sendFollowUpMessage !== 'function') return;
  const prompt = decision === 'deny'
    ? 'Continue after my WCM approval-card decision. I denied the frozen action; do not run it.'
    : 'Continue from the WCM approval result already placed in model context. WCM already handled the frozen approved action; do not recreate or rerun it.';
  try {
    await openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
  } catch {}
}

async function resolve(decision: 'approve' | 'deny') {
  if (busy || !approval?.approval_id || !approvalNonce) return;
  setBusy(true);
  setStatus(decision === 'approve' ? 'Executing approved hostname test…' : 'Denying request…');
  try {
    const result = await request<ToolResult>('tools/call', {
      name: 'resolve_approval_test',
      arguments: {
        approval_id: approval.approval_id,
        approval_nonce: approvalNonce,
        decision,
      },
    }, 120000);

    if (result?.isError) {
      setStatus(toolText(result) || 'Approval resolver returned an error.', true);
      setBusy(false);
      return;
    }

    const structured = (result?.structuredContent || {}) as ApprovalResult;
    approval = { ...approval, ...structured };
    renderApproval();

    if (approval.state === 'approved_retryable') {
      setStatus(approval.output || 'The action was not dispatched. You can retry the same frozen action.', true);
      setBusy(false);
      return;
    }
    if (approval.state === 'execution_unknown') {
      setStatus(approval.output || 'Execution outcome is unknown. WCM will not retry automatically.', true);
    } else if (approval.action_failed) {
      setStatus(approval.output || 'The approved action was not completed.', true);
    } else if (approval.state === 'denied') {
      setStatus('Denied. The command was not dispatched.');
    } else {
      setStatus(approval.output || toolText(result) || 'Decision recorded.');
    }
    setBusy(false);
    approve.disabled = true;
    deny.disabled = true;
    updateHeight();
    await notifyModel(decision, structured);
  } catch (error) {
    setStatus(`Approval action failed: ${error instanceof Error ? error.message : String(error)}`, true);
    setBusy(false);
  }
}

approve.addEventListener('click', () => { void resolve('approve'); });
deny.addEventListener('click', () => { void resolve('deny'); });

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(message.error.message || 'MCP Apps request failed'));
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method === 'ui/notifications/tool-result') {
    readInitialResult(message.params || null);
  }
});

window.addEventListener('openai:set_globals', () => {
  readInitialResult();
});

async function initialize() {
  const initialFromGlobals = readInitialResult();
  try {
    const initializeResult = await request<any>('ui/initialize', {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: {
        name: 'wcm-approval-test',
        title: 'WCM approval test',
        version: '1.0.0',
      },
      appCapabilities: {},
    }, 5000);
    post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    const hostLabel = initializeResult?.hostInfo?.name || initializeResult?.hostContext?.platform;
    if (hostLabel) host.textContent = String(hostLabel);
    if (!initialFromGlobals && !readInitialResult()) {
      setStatus('Connected. Waiting for approval details.');
    }
  } catch (error) {
    if (!readInitialResult()) {
      setStatus(`Approval card initialization failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}

void initialize();
