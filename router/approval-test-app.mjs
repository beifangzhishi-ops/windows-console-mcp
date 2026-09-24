import { createHash } from 'node:crypto';

// Host-facing approval View intentionally mirrors CCM's currently working ChatGPT surface.
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
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
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
      grid-template-columns: 92px minmax(0, 1fr);
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
    #approve, #approveAlways { background: color-mix(in srgb, currentColor 18%, transparent); }
    button:disabled { cursor: default; opacity: 0.45; }
    @media (max-width: 430px) {
      .row { grid-template-columns: 76px minmax(0, 1fr); }
      #card { padding: 12px; }
    }
  </style>
</head>
<body>
  <div id="card">
    <div id="title">WCM approval</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Device</div><div class="value" id="workspace"></div></div>
    <div class="row"><div class="label">Approval</div><div class="value" id="environment"></div></div>
    <div class="row"><div class="label">Expires</div><div class="value" id="expires"></div></div>
    <div class="row" id="policyScopeRow" hidden><div class="label">Always allow</div><div class="value" id="policyScope"></div></div>
    <div id="command"></div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="actions">
      <button id="deny" type="button">Deny</button>
      <button id="approve" type="button">Approve once</button>
      <button id="approveAlways" type="button">Always allow in workspace</button>
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

      const title = document.getElementById("title");
      const justification = document.getElementById("justification");
      const workspace = document.getElementById("workspace");
      const environment = document.getElementById("environment");
      const expires = document.getElementById("expires");
      const policyScopeRow = document.getElementById("policyScopeRow");
      const policyScope = document.getElementById("policyScope");
      const command = document.getElementById("command");
      const status = document.getElementById("status");
      const approve = document.getElementById("approve");
      const approveAlways = document.getElementById("approveAlways");
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
        return metadata && (
          metadata.mcp_tool_result || metadata.call_tool_result
        ) || null;
      }

      function readInitialResult(result = null) {
        const envelope = result || toolEnvelope();
        const structured = envelope?.structuredContent ||
          window.openai?.toolOutput || null;
        const hidden = envelope?._meta || {};
        if (!structured) return false;
        approval = structured;
        approvalNonce = hidden.approval_nonce || null;
        retryDecision = null;
        const workspaceAction = structured.kind === "workspace";
        title.textContent = workspaceAction
          ? (structured.operation === "register_workspace"
              ? "WCM requests workspace registration"
              : "WCM requests workspace access")
          : "WCM requests hostname approval";
        justification.textContent = structured.justification ||
          (workspaceAction
            ? "Allow this frozen workspace action?"
            : "Run this fixed read-only hostname test?");
        workspace.textContent = structured.device_id || "Unknown";
        environment.textContent = structured.approval_id || "Unknown";
        expires.textContent = structured.expires_at || "";
        const policyPersistable =
          !workspaceAction && structured.policy_persistable === true;
        policyScopeRow.hidden = !policyPersistable;
        if (policyPersistable) {
          const prefix = Array.isArray(structured.prefix_rule)
            ? structured.prefix_rule.join(" ")
            : "";
          policyScope.textContent = structured.policy_kind === "package_script"
            ? "Hash-bound package script: " + prefix
            : "Token prefix: " + prefix;
        } else {
          policyScope.textContent = "";
        }
        command.textContent = workspaceAction
          ? (structured.operation === "register_workspace"
              ? (structured.create_if_missing
                  ? "Create if missing, register, and enter this exact workspace."
                  : "Register and enter this exact workspace.")
              : "Enter this exact registered workspace.")
          : (structured.command || "");
        approve.textContent = workspaceAction ? "Approve" : "Approve once";
        approveAlways.hidden = !policyPersistable;
        approveAlways.disabled = !policyPersistable;
        if (structured.policy_auto_approved) {
          setStatus(
            "Automatically allowed by approval policy" +
            (structured.policy_rule_id ? " (" + structured.policy_rule_id + ")." : ".")
          );
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          updateHeight();
          return true;
        }
        if (!structured.approval_id) return false;
        if (!approvalNonce) {
          setStatus("Approval token is unavailable in this host.", true);
          approve.disabled = true;
          approveAlways.disabled = true;
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
        approveAlways.disabled =
          value || !approvalNonce || approval?.policy_persistable !== true;
        deny.disabled = value || !approvalNonce;
      }

      function resultSummary(structured) {
        return {
          source: "wcm.approval",
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          kind: structured?.kind,
          operation: structured?.operation,
          workspace_context: structured?.workspace_context,
          environment_id: structured?.environment_id,
          workspace_id: structured?.workspace_id,
          workspace_root: structured?.workspace_root,
          session_id: structured?.session_id,
          exit_code: structured?.exit_code,
          policy_saved: structured?.policy_saved,
          policy_rule_id: structured?.policy_rule_id,
          policy_prefix_tokens: structured?.policy_prefix_tokens,
          policy_save_failed: structured?.policy_save_failed,
          policy_save_error: structured?.policy_save_error,
          action_failed: structured?.action_failed,
          output: typeof structured?.output === "string"
            ? structured.output.slice(0, 12000)
            : ""
        };
      }

      async function notifyModel(decision, structured) {
        const summary = {
          ...resultSummary(structured),
          decision
        };
        const workspaceAction =
          structured?.kind === "workspace" || approval?.kind === "workspace";
        const contextText = workspaceAction
          ? (decision === "deny"
              ? "The user denied the frozen WCM workspace action; do not retry it."
              : structured?.action_failed
                ? "The approved WCM workspace action failed safely and was consumed; request a new approval before retrying."
                : "The user approved the frozen WCM workspace action. WCM completed it and returned the workspace context; do not recreate or retry the workspace action.")
          : (decision === "deny"
              ? "The user denied the frozen WCM approval test action."
              : decision === "approve_workspace"
                ? (structured?.policy_save_failed
                    ? "The user approved the frozen WCM approval test action. The command already executed, but saving the persistent policy failed; do not rerun the command to retry persistence."
                    : "The user approved the frozen WCM approval test action and asked WCM to allow future matching executions in this workspace.")
                : "The user approved the frozen WCM approval test action and WCM handled it without a second model execution request.");
        try {
          await request("ui/update-model-context", {
            content: [{
              type: "text",
              text: contextText
            }],
            structuredContent: summary
          }, 10000);
        } catch {}

        const openai = window.openai;
        if (!openai || typeof openai.sendFollowUpMessage !== "function") return;
        const prompt = workspaceAction
          ? "Continue from the WCM workspace approval result already placed in model context. Do not recreate or rerun the workspace action."
          : decision === "deny"
            ? "Continue after my WCM approval-card decision. I denied the frozen action; do not run it."
            : decision === "approve_workspace"
              ? "Continue from the WCM approval result already placed in model context. WCM handled the action and saved the approval policy; do not recreate or rerun that command."
              : "Continue from the WCM approval result already placed in model context. WCM already handled the frozen approved action; do not recreate or rerun that command.";
        try {
          await openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
        } catch {}
      }

      async function resolve(decision) {
        if (busy || !approval || !approvalNonce) return;
        if (approval.kind === "workspace" && decision === "approve_workspace") {
          return;
        }
        if (approval.kind !== "workspace" &&
            (decision === "approve" || decision === "approve_workspace")) {
          retryDecision = decision;
        }
        setBusy(true);
        const workspaceAction = approval.kind === "workspace";
        setStatus(
          decision === "deny"
            ? "Denying request…"
            : decision === "approve_workspace"
              ? "Executing and saving approval policy…"
              : workspaceAction
                ? "Applying approved workspace action…"
                : "Executing approved action…"
        );
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
            approve.textContent = "Retry approved action";
            setStatus(
              structured.output ||
                (retryDecision === "approve_workspace"
                  ? "The action was not dispatched. Retry will keep the approval policy approval."
                  : "The action was not dispatched. You can retry the same frozen action."),
              true
            );
            setBusy(false);
            deny.disabled = false;
            return;
          }
          if (structured.state === "execution_unknown") {
            setStatus(structured.output || "Execution outcome is unknown. WCM will not retry automatically.", true);
          } else if (structured.action_failed) {
            setStatus(structured.output || "The approved workspace action was not performed.", true);
          } else if (structured.state === "denied") {
            setStatus(
              workspaceAction
                ? "Denied. No workspace change was made."
                : "Denied. The command was not dispatched."
            );
          } else if (structured.policy_save_failed) {
            setStatus(
              "Approved and executed, but the persistent policy was not saved. " +
                (structured.policy_save_error || ""),
              true
            );
          } else if (structured.policy_saved) {
            setStatus(
              structured.trusted_package_script
                ? "Approved, executed, and saved as a hash-bound package-script rule."
                : "Approved, executed, and saved with the displayed token-prefix scope."
            );
          } else if (structured.session_id != null) {
            setStatus("Approved and started. Session ID: " + structured.session_id);
          } else if (structured.exit_code != null) {
            setStatus("Approved and completed with exit code " + structured.exit_code + ".");
          } else if (structured.workspace_context) {
            setStatus(structured.output || "Approved and entered workspace.");
          } else {
            setStatus(structured.output || "Decision recorded.");
          }
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          void notifyModel(decision, structured);
        } catch (error) {
          setStatus(
            "Approval action failed: " +
              String(error && error.message ? error.message : error),
            true
          );
          setBusy(false);
        }
      }

      approve.addEventListener("click", () => {
        void resolve(retryDecision || "approve");
      });
      approveAlways.addEventListener("click", () => {
        if (approval?.policy_persistable === true) {
          void resolve("approve_workspace");
        }
      });
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
          if (message.error) {
            waiter.reject(new Error(message.error.message || "MCP Apps request failed"));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          readInitialResult(message.params || null);
        }
      });

      window.addEventListener("openai:set_globals", () => {
        readInitialResult();
      });

      async function initialize() {
        try {
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "wcm-approval",
              title: "WCM approval",
              version: "0.1.0"
            },
            appCapabilities: {}
          }, 5000);
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) {
            setStatus("Waiting for approval details…");
          }
        } catch (error) {
          setStatus(
            "Approval card initialization failed: " +
              String(error && error.message ? error.message : error),
            true
          );
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;

const bundleHash = createHash('sha256').update(APPROVAL_TEST_UI_HTML).digest('hex').slice(0, 16);
export const APPROVAL_TEST_UI_URI = `ui://wcm/approval-test/${bundleHash}.html`;
