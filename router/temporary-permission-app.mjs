export const TEMP_PERMISSION_UI_URI = 'ui://wcm/temporary-permission-v1.html';

export const TEMP_PERMISSION_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: transparent; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: 2px; }
    #card { width: 100%; padding: 14px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 14px; background: color-mix(in srgb, Canvas 95%, currentColor 5%); color: CanvasText; }
    #title { font-size: 14px; font-weight: 700; line-height: 1.35; }
    #justification { margin-top: 5px; font-size: 13px; line-height: 1.4; }
    .row { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px; margin-top: 8px; font-size: 12px; line-height: 1.35; }
    .label { opacity: 0.62; }
    .value { min-width: 0; overflow-wrap: anywhere; }
    #scope { margin-top: 10px; padding: 9px 10px; border-radius: 10px; background: color-mix(in srgb, currentColor 7%, transparent); font-size: 12px; line-height: 1.45; }
    #status { margin-top: 10px; font-size: 12px; line-height: 1.4; opacity: 0.72; white-space: pre-wrap; overflow-wrap: anywhere; }
    #status[data-error="true"] { opacity: 1; }
    #actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    button { border: 0; border-radius: 999px; padding: 8px 13px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; color: inherit; background: color-mix(in srgb, currentColor 11%, transparent); }
    #approve { background: color-mix(in srgb, currentColor 18%, transparent); }
    button:disabled { cursor: default; opacity: 0.45; }
  </style>
</head>
<body>
  <div id="card">
    <div id="title">WCM temporary permission</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Device</div><div class="value" id="device"></div></div>
    <div class="row"><div class="label">Request expires</div><div class="value" id="requestExpires"></div></div>
    <div class="row"><div class="label">Permission length</div><div class="value" id="duration"></div></div>
    <div id="scope">Scope: all Desktop Commander tools routed by WCM to this device.</div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="actions">
      <button id="deny" type="button">Deny</button>
      <button id="approve" type="button">Approve for 6 hours</button>
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
      const justification = document.getElementById("justification");
      const device = document.getElementById("device");
      const requestExpires = document.getElementById("requestExpires");
      const duration = document.getElementById("duration");
      const status = document.getElementById("status");
      const approve = document.getElementById("approve");
      const deny = document.getElementById("deny");

      function post(message) { window.parent.postMessage(message, "*"); }
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
      function readInitialResult(result = null) {
        const envelope = result || toolEnvelope();
        const structured = envelope?.structuredContent || window.openai?.toolOutput || null;
        const hidden = envelope?._meta || {};
        if (!structured) return false;
        approval = structured;
        approvalNonce = hidden.approval_nonce || null;
        justification.textContent = structured.justification || "Allow temporary WCM access?";
        device.textContent = structured.device_id || "Unknown";
        requestExpires.textContent = structured.approval_expires_at || "";
        const seconds = Number(structured.requested_duration_seconds || 0);
        const hours = seconds ? Math.round((seconds / 3600) * 100) / 100 : 6;
        duration.textContent = hours + " hours";
        approve.textContent = "Approve for " + hours + " hours";
        if (!structured.approval_id || !approvalNonce) {
          setStatus("Approval token is unavailable in this host.", true);
          approve.disabled = true;
          deny.disabled = true;
        }
        updateHeight();
        return true;
      }
      async function notifyModel(decision, structured) {
        const summary = {
          source: "wcm.temporary_permission",
          decision,
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          intent_sha256: structured?.intent_sha256,
          permission_id: structured?.permission_id,
          device_id: structured?.device_id,
          issued_at: structured?.issued_at,
          expires_at: structured?.expires_at
        };
        const contextText = decision === "deny"
          ? "The user denied the WCM temporary permission request."
          : "The user approved the frozen WCM temporary-permission action. WCM issued the permission without a second model approval request; use permission_id only for the matching device until expires_at.";
        try {
          await request("ui/update-model-context", {
            content: [{ type: "text", text: contextText }],
            structuredContent: summary
          }, 10000);
        } catch {}
        const openai = window.openai;
        if (!openai || typeof openai.sendFollowUpMessage !== "function") return;
        const prompt = decision === "deny"
          ? "Continue after my WCM approval-card decision. I denied the temporary permission."
          : "Continue from the WCM temporary permission result already placed in model context. Use the returned permission_id for the matching device.";
        try { await openai.sendFollowUpMessage({ prompt, scrollToBottom: false }); } catch {}
      }
      async function resolve(decision) {
        if (busy || !approval || !approvalNonce) return;
        setBusy(true);
        setStatus(decision === "deny" ? "Denying request..." : "Issuing temporary permission...");
        try {
          const result = await request("tools/call", {
            name: "resolve_temporary_permission",
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce,
              decision
            }
          }, 30000);
          const structured = result?.structuredContent || {};
          approval = { ...approval, ...structured };
          if (structured.state === "approved_retryable") {
            approve.textContent = "Retry approved permission";
            setStatus(
              structured.error ||
                "The permission was not issued. You can retry the same frozen approved action.",
              true
            );
            setBusy(false);
            deny.disabled = false;
            return;
          }
          if (structured.state === "execution_unknown") {
            setStatus(
              structured.error ||
                "Permission issuance outcome is unknown. WCM will not retry automatically.",
              true
            );
          } else
          if (structured.state === "denied") {
            setStatus("Denied. No permission was issued.");
          } else if (structured.state === "consumed" && structured.permission_id) {
            setStatus("Approved until " + (structured.expires_at || "") + ".");
          } else {
            setStatus("Permission decision returned an unexpected state.", true);
          }
          approve.disabled = true;
          deny.disabled = true;
          void notifyModel(decision, structured);
        } catch (error) {
          setStatus("Approval action failed: " + String(error?.message || error), true);
          setBusy(false);
        }
      }
      approve.addEventListener("click", () => { void resolve("approve"); });
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
      window.addEventListener("openai:set_globals", () => { readInitialResult(); });
      async function initialize() {
        try {
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: { name: "wcm-temporary-permission", title: "WCM temporary permission", version: "1.0.0" },
            appCapabilities: {}
          }, 5000);
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) setStatus("Waiting for approval details...");
        } catch (error) {
          setStatus("Approval card initialization failed: " + String(error?.message || error), true);
        }
      }
      void initialize();
    })();
  </script>
</body>
</html>`;
