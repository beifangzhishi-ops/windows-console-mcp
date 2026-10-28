# Agent Notes

## MCP branding asset

- The only published WCM icon path is `/rdc/icon.png` (served by the OAuth sidecar without credentials); its bytes come exclusively from `assets/wcm-icon.png`. No general file-serving routes or authentication exemptions for `/rdc/mcp`.
- `router/server-info.mjs` must advertise that **same-origin HTTPS** URL through `initialize.serverInfo.icons` only while a valid PNG is present. Keep the Tailscale Funnel allowlist in `scripts/configure-rdc-funnel.ps1` and `scripts/disable-rdc-funnel.ps1` in sync.
- ChatGPT plugin creation **requires manual icon upload under 10 KB**. Upload `assets/wcm-plugin-icon.png` (optimized transparency-preserving PNG), **not** the full-resolution `assets/wcm-icon.png` or its URL. MCP server icon metadata is separate from ChatGPT plugin creation and does not replace the manual upload. Keep the derived PNG under 10,000 bytes (prefer a 9,000-byte build budget); regenerate it with `scripts/build-plugin-icon.py` after source image changes, and verify it using `scripts/test-icon.mjs`.
- `assets/ICON_PROMPT.txt` is the authoritative production prompt. Generate/revise the original artwork only with the explicitly selected CPA ImgGen workflow, inspect the candidate, and never substitute a synthetic placeholder or another backend silently. Deriving the smaller upload copy through deterministic resizing and PNG quantization is permitted. CPA credentials must stay in secure local client configuration or environment variables, never in prompts, scripts, or commits.

## Test safety on the live WCM host

- The WCM Controller gateway and native remote Worker Scheduled Tasks run under an administrator account with `RunLevel Highest`, using an interactive logon trigger. They inherit elevated rights to supervised child processes. The independent diagnostics watchdog remains `RunLevel Limited`.
- Privilege changes to existing tasks require an elevated Windows administrator shell. Before updating an existing task, preserve its original task principal/action/triggers/settings, validate that the account belongs to Administrators, and verify effective task `RunLevel` and the new process token after a scoped restart. Never restart unrelated tasks or kill unrelated processes.
- Always use the qualified `domain\\username` account returned by `whoami.exe` when registering elevated interactive Scheduled Task principals. A short `UserId` read from an existing task can be rejected by `Set-ScheduledTask` when reused for a `Highest` principal.
- The repository scripts and ignored `.state/` launchers become elevated executable inputs; protect their write access from untrusted accounts. WCM timed approval still controls routed calls, but it is not a Windows privilege boundary once the worker has an elevated token.

- Diagnostics watchdog login autostart is managed by `scripts/install-diagnostics-watchdog.ps1`: use its generated hidden WScript launcher, not a direct PowerShell Scheduled Task (which can expose a console despite `-WindowStyle Hidden`). Keep the watchdog and `Desktop Commander Selfhost Gateway` tasks independent. Reconfigure/restart only the watchdog when fixing its window; do not interrupt the gateway. Watchdog diagnostics live in `logs/watchdog/`.

- Read this before running repository tests from ChatGPT/WCM.
- `npm test` is self-contained with respect to test data/config, but do **not** launch it through the same live WCM connection that is controlling this checkout.
- In practice, running `npm test` from the active WCM session can interrupt the worker/gateway transport and make subsequent WCM tool calls return HTTP 502 until the gateway reconnects or is restarted.
- This 502 is an operational/self-hosting failure, not a WCM command-blocklist rejection.
- Prefer running `npm test` from an independent local PowerShell/terminal outside the active WCM control path. If that is unavailable, run only the smallest targeted test needed and avoid tests that spawn/tear down gateway-like worker processes.
- Do not restart or stop the live gateway from inside its own WCM session unless an independent recovery path is already available.
- `restart_wcm` is a Router-local, no-argument, no-approval request to the existing Supervisor. It cannot dispatch commands or select a remote device; a returned `accepted` means the Supervisor will perform the restart asynchronously, not that health has recovered. Use an independent CCM channel to observe recovery. Never replace this narrow exception with arbitrary no-approval process execution.
- After a Router tool/schema deployment, use ChatGPT's plugin-management **Refresh tools** control rather than a new plugin registration; check the refreshed schema before relying on it.

## WCM error semantics

- WCM approval cards use only `ui://wcm/approval-v2.html`; do not add compatibility aliases or old card URIs. An authenticated, app-only, read-only `get_approval_status` verifies original nonce, operation ID, and optional Host session. Do not substitute model-facing `approval_status` for this check.
- After reconnect/remount, the card must fail closed until its own live pending state is verified. Persist only bounded minimal terminal receipts under `logs/approval-receipts.json`; they can explain a historical decision but never restore grant rights, pending actions, or worker execution. UI widget state is display-only, never a source of authority. Failed ChatGPT continuation must never re-run a frozen owner action.

- Only a result explicitly classified as `WCM classification: command_blocked`, originating from the exact upstream marker `Error: Command not allowed`, means the WCM command blocklist rejected the command.
- Schema/argument errors, path errors, command-not-found errors, non-zero exits, HTTP 502, worker disconnects, and runtime/process failures are not command-blocklist rejections.
- A single network/site error such as `Network is unreachable`, DNS failure, timeout, connection reset, HTTP 403/404, or target-site verification/challenge does not mean WCM or the target device is unavailable. Check `list_devices`, retry transient network requests 2-3 times when appropriate, and only conclude WCM/device connectivity is unavailable when the device is reported offline or repeated harmless local WCM checks fail.

## Native remote worker operations

- Native remote workers reuse `worker/agent.mjs`; do not create a separate protocol or Router path for them.
- The native worker Scheduled Task is per device and owns only its matching supervisor/agent process tree. Never kill unrelated Node processes during install, restart, or uninstall.
- Never run Docker and native workers concurrently with the same `deviceId`; stop the old worker before cutover and verify exactly one connection afterward.
- Native Windows workers must not retain Docker path mappings such as `C:\ -> /host`. Controller `config/devices.json` is loaded at Router startup, so a mapping change takes effect only after a controlled Router restart.
- Do not restart the Controller Router from the WCM path it is currently carrying unless an independent recovery/control path is available.

## Upstream Desktop Commander boundary

- Treat the bundled Desktop Commander tool implementations, worker-facing tool schemas, and worker protocol as upstream code. WCM-specific features must not patch or fork those upstream tool implementations merely to add WCM behavior.
- Add WCM-only capabilities through the Router augmentation layer instead: Router-local tools, routing metadata, approval/state management, path/device routing, and result handling belong in the Router. ChatGPT-facing routed-tool schemas may add Router-only fields such as `deviceId` and `approval_id`, but those fields must be stripped before worker dispatch.
- Existing Desktop Commander tool names, business arguments, worker-side schemas, and worker protocol should remain compatible with upstream so future Desktop Commander updates can be synchronized without carrying WCM-specific patches through the upstream tool source.
- If a WCM feature would otherwise require changing an upstream Desktop Commander tool, keep the behavior in Router-side schema augmentation or orchestration. Change upstream-derived tool code only when the user explicitly approves that boundary change.
