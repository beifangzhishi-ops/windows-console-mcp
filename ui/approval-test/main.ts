import { App } from '@modelcontextprotocol/ext-apps';
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

function setStatus(message: string, isError = false) {
  status.textContent = message;
  status.dataset.error = isError ? 'true' : 'false';
}

function setBusy(value: boolean) {
  busy = value;
  const enabled = !value && Boolean(approval?.approval_id && approvalNonce);
  approve.disabled = !enabled;
  deny.disabled = !enabled;
}

function toolText(result: any) {
  return Array.isArray(result?.content)
    ? result.content.filter((item: any) => item?.type === 'text').map((item: any) => item.text).join('\n')
    : '';
}

function applyToolResult(result: any) {
  const structured = (result?.structuredContent || {}) as ApprovalResult;
  const meta = (result?._meta || {}) as Record<string, unknown>;
  if (typeof meta.approval_nonce === 'string') approvalNonce = meta.approval_nonce;
  if (!structured.approval_id) return;

  approval = { ...(approval || {}), ...structured };
  device.textContent = approval.device_id || '—';
  approvalId.textContent = approval.approval_id || '—';
  expires.textContent = approval.expires_at || '—';
  justification.textContent = approval.justification || 'Approve the fixed read-only hostname test?';
  command.textContent = approval.command || 'hostname';
  details.hidden = false;

  if (!approvalNonce && approval.state === 'pending') {
    setStatus('Connected, but the approval token was not delivered by the host.', true);
  } else if (approval.state === 'pending') {
    setStatus('Connected. Waiting for your decision.');
  } else {
    setStatus(approval.output || toolText(result) || `State: ${approval.state || 'unknown'}`, Boolean(approval.action_failed));
  }
  setBusy(false);
}

const app = new App(
  { name: 'wcm-approval-test', version: '1.0.0' },
  {},
  { autoResize: true, strict: true },
);

app.addEventListener('toolresult', (result) => {
  applyToolResult(result);
});

app.addEventListener('hostcontextchanged', (context) => {
  host.textContent = String(context.platform || context.locale || app.getHostVersion()?.name || 'Connected host');
});

async function notifyModel(decision: 'approve' | 'deny', result: ApprovalResult) {
  const text = decision === 'deny'
    ? 'The user denied the frozen WCM approval test action. Do not execute it.'
    : 'The user approved the frozen WCM approval test action. WCM already handled the frozen action; do not recreate or rerun it.';
  try {
    await app.updateModelContext({
      content: [{ type: 'text', text }],
      structuredContent: {
        source: 'wcm.approval-test',
        decision,
        approval_id: result.approval_id,
        operation_id: result.operation_id,
        state: result.state,
        device_id: result.device_id,
        output: result.output,
      },
    });
  } catch {}
  try {
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Continue from the WCM approval-test result already placed in model context.' }],
    });
  } catch {}
}

async function resolve(decision: 'approve' | 'deny') {
  if (busy || !approval?.approval_id || !approvalNonce) return;
  setBusy(true);
  setStatus(decision === 'approve' ? 'Executing approved hostname test…' : 'Denying request…');
  try {
    const result = await app.callServerTool({
      name: 'resolve_approval_test',
      arguments: {
        approval_id: approval.approval_id,
        approval_nonce: approvalNonce,
        decision,
      },
    }, { timeout: 120000 });
    if (result.isError) {
      setStatus(toolText(result) || 'Approval resolver returned an error.', true);
      setBusy(false);
      return;
    }
    applyToolResult(result);
    const structured = (result.structuredContent || {}) as ApprovalResult;
    approve.disabled = true;
    deny.disabled = true;
    await notifyModel(decision, structured);
  } catch (error) {
    setStatus(`Approval action failed: ${error instanceof Error ? error.message : String(error)}`, true);
    setBusy(false);
  }
}

approve.addEventListener('click', () => { void resolve('approve'); });
deny.addEventListener('click', () => { void resolve('deny'); });

void (async () => {
  try {
    await app.connect();
    const version = app.getHostVersion();
    const context = app.getHostContext();
    host.textContent = String(context?.platform || context?.locale || version?.name || 'Connected host');
    if (!approval) setStatus('Connected. Waiting for approval details…');
  } catch (error) {
    setStatus(`MCP App initialization failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
})();
