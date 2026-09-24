export const APPROVAL_TEST_UI_URI = 'ui://wcm/approval-test-v1.html';

export const APPROVAL_TEST_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { padding: 2px; }
    #card {
      width: 100%;
      padding: 14px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, Canvas 95%, currentColor 5%);
      color: CanvasText;
    }
    #title { font-size: 14px; font-weight: 700; line-height: 1.35; }
    #justification { margin-top: 5px; font-size: 13px; line-height: 1.4; }
    .row {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.35;
    }
    .label { opacity: 0.62; }
    .value { min-width: 0; overflow-wrap: anywhere; }
    #command {
      margin-top: 10px;
      padding: 9px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, currentColor 7%, transparent);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.4;
      opacity: 0.72;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status[data-error="true"] { opacity: 1; }
    #actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 8px 13px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      color: inherit;
      background: color-mix(in srgb, currentColor 11%, transparent);
    }
    #approve { background: color-mix(in srgb, currentColor 18%, transparent); }
    button:disabled { cursor: default; opacity: 0.45; }
  </style>
</head>
<body>
  <div id="card">
    <div id="title">WCM approval test</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Device</div><div class="value" id="device"></div></div>
    <div class="row"><div class="label">Approval</div><div class="value" id="approvalId"></div></div>
    <div class="row"><div class="label">Expires</div><div class="value" id="expires"></div></div>
    <div id="command"></div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="actions">
      <button id="deny" type="button">Deny</button>
      <button id="approve" type="button">Approve</button>
    </div>
  </div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let approval = null;
      let approvalNonce = null;
      let busy = false;
      let retryDecision = null;

      const justification = document.getElementById("justification");
      const device = document.getElementById("device");
      const approvalId = document.getElementById("approvalId");
      const expires = document.getElementById("expires");
      const command = document.getElementById("command");
      const status = document.getElementById("status");
      const approve = document.getElementById("approve");
      const deny = document.getElementById("deny");

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 30000) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          post({ jsonrpc: "2.0", id, method, params });
        });
      }

      function toolEnvelope() {
        const metadata = window.openai?.toolResponseMetadata;
        return metadata && (metadata.mcp_tool_result || metadata.call_tool_result) || null;
      }

      function readInitialResult(result = null) {
        const envelope = result || toolEnvelope();
        const structured = envelope?.structuredContent || window.openai?.toolOutput || null;
        const hidden = envelope?._meta || {};
        if (!structured) return false;
        approval = structured;
        approvalNonce = hidden.approval_nonce || null;
        retryDecision = null;
        justification.textContent = structured.justification || "Run this frozen WCM approval test command?";
        device.textContent = structured.device_id || "Unknown";
        approvalId.textContent = structured.approval_id || "";
        expires.textContent = structured.expires_at || "";
        command.textContent = structured.command || "";
        if (!structured.approval_id) return false;
        if (!approvalNonce) {
          setStatus("Approval token is unavailable in this host.", true);
          approve.disabled = true;
          deny.disabled = true;
        }
        updateHeight();
        return true;
      }

      function updateHeight() {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }

      function setStatus(text, error = false) {
        status.textContent = text || "";
        status.dataset.error = error ? "true" : "false";
        updateHeight();
      }

      function setBusy(value) {
        busy = value;
        approve.disabled = value || !approvalNonce;
        deny.disabled = value || !approvalNonce;
      }

      function resultSummary(structured) {
        return {
          source: "wcm.approval-test",
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          device_id: structured?.device_id,
          command: structured?.command,
          action_failed: structured?.action_failed,
          output: typeof structured?.output === "string" ? structured.output.slice(0, 12000) : ""
        };
      }

      async function notifyModel(decision, structured) {
        const summary = { ...resultSummary(structured), decision };
        const contextText = decision === "deny"
          ? "The user denied the frozen WCM approval test command; do not run it."
          : structured?.state === "execution_unknown"
            ? "The approved WCM test command has an unknown execution outcome; do not retry it automatically."
            : "The user approved the frozen WCM approval test command. WCM executed it through the approval resolver; do not recreate or rerun it.";
        try {
          await request("ui/update-model-context", {
            content: [{ type: "text", text: contextText }],
            structuredContent: summary
          }, 10000);
        } catch {}

        const openai = window.openai;
        if (!openai || typeof openai.sendFollowUpMessage !== "function") return;
        const prompt = decision === "deny"
          ? "Continue after my WCM approval-test decision. I denied the frozen command; do not run it."
          : "Continue from the WCM approval-test result already placed in model context. WCM already handled the frozen command; do not recreate or rerun it.";
        try {
          await openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
        } catch {}
      }

      async function resolve(decision) {
        if (busy || !approval || !approvalNonce) return;
        if (decision === "approve") retryDecision = decision;
        setBusy(true);
        setStatus(decision === "deny" ? "Denying request..." : "Executing approved test command...");
        try {
          const result = await request("tools/call", {
            name: "resolve_approval_test",
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce,
              decision
            }
          }, 120000);
          const structured = result?.structuredContent || {};
          approval = { ...approval, ...structured };
          if (structured.state === "approved_retryable") {
            approve.textContent = "Retry approved command";
            setStatus(structured.output || "The test command was not dispatched. You can retry the same frozen command.", true);
            setBusy(false);
            deny.disabled = false;
            return;
          }
          if (structured.state === "execution_unknown") {
            setStatus(structured.output || "Execution outcome is unknown. WCM will not retry automatically.", true);
          } else if (structured.state === "denied") {
            setStatus("Denied. The test command was not dispatched.");
          } else if (structured.action_failed) {
            setStatus(structured.output || "The approved test command failed.", true);
          } else if (structured.state === "consumed") {
            setStatus(structured.output || "Approved test command completed.");
          } else {
            setStatus(structured.output || "Decision recorded.");
          }
          approve.disabled = true;
          deny.disabled = true;
          void notifyModel(decision, structured);
        } catch (error) {
          setStatus("Approval action failed: " + String(error && error.message ? error.message : error), true);
          setBusy(false);
        }
      }

      approve.addEventListener("click", () => { void resolve(retryDecision || "approve"); });
      deny.addEventListener("click", () => { void resolve("deny"); });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(message.error.message || "MCP Apps request failed"));
          else waiter.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") readInitialResult(message.params || null);
      });

      window.addEventListener("openai:set_globals", () => {
        readInitialResult();
      });

      async function initialize() {
        try {
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: { name: "wcm-approval-test", title: "WCM approval test", version: "1.0.0" },
            appCapabilities: {}
          }, 5000);
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) setStatus("Waiting for approval details...");
        } catch (error) {
          setStatus("Approval card initialization failed: " + String(error && error.message ? error.message : error), true);
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
