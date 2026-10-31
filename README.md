# Windows Console MCP

Self-hosted multi-device Windows MCP controller for ChatGPT.

One controller owns the public OAuth/Funnel endpoint. Local and remote workers expose Desktop Commander through the controller with an explicit `deviceId` on every routed worker tool call.

## Architecture

```text
ChatGPT
  |
  | OAuth + MCP
  v
Tailscale Funnel /rdc/mcp
  |
  v
Controller
  |- OAuth sidecar        127.0.0.1:18008
  |- MCP router           127.0.0.1:18009
  |- Local worker hub     127.0.0.1:18101
  |- local worker         deviceId=local-pc
  `- Remote worker hub    <Tailscale IPv4>:18100
       `- remote workers  deviceId=remote-worker, ...
```

The public `/rdc/mcp` endpoint uses the MCP SDK `StreamableHTTPServerTransport`, matching CCM's standard initialize/session lifecycle.

## UU Remote CLI (no additional agent on temporary PCs)

The Controller exposes one Router-local `uuyc_cli` tool which forwards native arguments to the installed `C:\Program Files\Netease\GameViewer\bin\uuyc-cli.exe`. Its Windows ConPTY adapter runs on the Controller only (prebuilt `@lydell/node-pty` dependency). The remote Windows PC needs only the UU Remote client, a logged-in account, and UU's remote-terminal capability; it does **not** need SSH, Tailscale, Python, or a WCM Worker.

- Discover UU devices with `{ "args": ["device", "ls", "--json"], "approval_id": "<active WCM grant>" }`.
- Open an interactive remote terminal with `{ "args": ["term", "-d", "<UU device ID>", "new", "session-name"], "approval_id": "<active WCM grant>" }`. A running process returns a `session_id`; use the **same tool** with `session_id`, `stdin` (for example `"hostname\r"`), and the **same** `approval_id` to continue. `close: true` terminates that local CLI session.
- `timeout_ms` is a per-call wait of up to 20 seconds, not the lifetime of the remote command. Output is raw terminal text and may contain ANSI control codes; an exit returns `exit_code`. A session is bounded to 10 minutes, 8 concurrent sessions, and the original grant's expiration.
- **Exactly the standard WCM timed full-access approval applies.** Omitting `approval_id` in timed mode creates the regular WCM approval card; after approval the same grant covers UU CLI and all WCM worker tools. No second approval service, grant or database is introduced. Expiration, policy change, or session closing terminates the Controller-side PTY. UU remote Windows permissions remain those of the UU remote terminal, not an automatic elevation.
- The Controller needs a live UU GUI/IPC session under the same Windows login context as its Router. A simultaneous UU GUI remote-control session can make `term` return error 127. If needed, set `WC_UU_CLI_PATH` to the full path of the Controller's official UU CLI executable. No passwords, SSH keys or UU credentials are passed through WCM.

The Router tool can reach any UU device authorized under the Controller's UU account; this intentionally broadens the reach of the existing `full_wcm` grant. Restrict who can approve WCM access and use the UU account accordingly. This is a native CLI wrapper, not a reimplementation of UU's protocol.

## MCP identity icon

WCM has a dedicated, public PNG endpoint at `/rdc/icon.png` on the same HTTPS origin as the protected `/rdc/mcp` endpoint. The sidecar serves only the fixed repository asset `assets/wcm-icon.png` (GET and HEAD, no OAuth needed); it does **not** expose a general file server. The MCP `initialize.serverInfo` includes the icon's absolute HTTPS URL and its actual dimensions only when the PNG exists and passes basic file checks. With no image installed, icon metadata is omitted rather than advertising a broken link. The server display title is `Windows Console MCP`.

The full-resolution icon is [`assets/wcm-icon.png`](assets/wcm-icon.png), an approved transparent **512 x 512 PNG** generated through CPA ImgGen. Its canonical generation brief is [`assets/ICON_PROMPT.txt`](assets/ICON_PROMPT.txt). To regenerate the full-resolution icon, use the CPA ImgGen client's local mode on the registered CPA worker (which securely retrieves its local client credentials), or provide `CPA_BASE_URL` and `CPA_API_KEY` through a secure environment for remote mode. Never commit credentials or generation candidates. The endpoint returns 404 if the full-resolution icon is unavailable.

**ChatGPT plugin icon setup:** Actual plugin creation requires **manual image upload**, and the image must be **under 10 KB**. Use [`assets/wcm-plugin-icon.png`](assets/wcm-plugin-icon.png): an independently reviewed, transparent **128 x 128 PNG (4,139 bytes)** derived from the approved WCM icon. This is the file to download and select in ChatGPT's plugin-creation icon upload field; do **not** upload the 147 KB full-resolution PNG. When the source icon changes, regenerate the upload PNG using `scripts/build-plugin-icon.py` (requires Python and Pillow); the script targets at most 9,000 bytes to leave margin beneath the UI limit, and `scripts/test-icon.mjs` verifies the output. **The plugin-creation interface does not automatically import the `initialize.serverInfo.icons` URL.**

The Tailscale Funnel is configured with **exact path mappings**, so apply the updated `scripts/configure-rdc-funnel.ps1` route configuration when deploying the full-resolution icon. The route list includes `/rdc/icon.png`; its removal counterpart is `scripts/disable-rdc-funnel.ps1`. Deploying a changed server-provided icon also requires restarting the Controller Router and sidecar using the supervised lifecycle so new MCP sessions advertise it. This URL is available to MCP clients supporting server icon metadata, **not as a replacement for ChatGPT's required manual plugin icon upload**.

## Controller setup

The Controller Supervisor Scheduled Task runs with **highest available Windows privileges** under the installing administrator account (`RunLevel Highest`, interactive logon). Its Router, local Worker, and OAuth sidecar child processes inherit that token. Install or update this task from an elevated Administrator PowerShell terminal, with an account belonging to the local Administrators group. This does not change WCM's independent timed approval mechanism. The scripts and generated `.state/` launchers must not be writable by untrusted accounts.

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rdc-enable-oauth.ps1 `
  -PublicBaseUrl https://your-machine.your-tailnet.ts.net
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-rdc-autostart.ps1
```

Runtime configuration is intentionally local-only:

```text
config/rdc.env
config/devices.json
config/worker-*.env
.state/
logs/
```

### Diagnostics watchdog autostart

The independent diagnostics watchdog intentionally remains at `RunLevel Limited`; elevating the WCM Controller does not elevate this diagnostic task.

To keep the long-running WCM diagnostics watchdog active after interactive
Windows logon **without opening a visible terminal**, install its dedicated
scheduled task:

```powershell
& "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Documents\ChatGPT\windows-console-mcp\scripts\install-diagnostics-watchdog.ps1"
```

The installer writes a generated WScript launcher under the ignored `.state/`
directory, then registers the `WCM Diagnostics Watchdog` logon task if absent,
or updates only the existing task's action (preserving its account, triggers,
and settings). The launcher starts `scripts/diagnostics-watchdog.ps1` with the WScript hidden-window
flag and waits for the monitor. Rerunning the installer refreshes the existing
task configuration; after updating a running task, end **only that watchdog
task** and start it again to apply the changed action. Never stop the
`Desktop Commander Selfhost Gateway` task for a watchdog-only change.

The watchdog remains single-instance through its named mutex; it records
diagnostics under `logs/watchdog/`. Verify the task's action points to
`wscript.exe` and that its log shows `watchdog started`. The gateway itself
uses the separate installer `scripts/install-rdc-autostart.ps1`.

`config/devices.json.example` shows the registry format. Local workers use a local token. Remote workers are bound to their registered Tailscale IPv4 and are accepted only on the controller's Tailscale-bound TCP listener.

## Remote workers

Native remote Worker Scheduled Tasks also use `RunLevel Highest` under the installing administrator account. Install or update them from elevated Administrator PowerShell. The remote Worker Supervisor and Desktop Commander child inherit the elevated token on their own host (elevating the Controller alone does not grant remote Windows administrator rights). Existing task definitions are not changed until reconfigured, and an already-running process must be restarted to acquire the new token. Preserve the task's existing action, user, trigger, and settings during a privilege-only change.

Remote workers do not run OAuth or Funnel. They connect directly to the Controller's Tailscale-bound worker hub.

Windows remote workers can run natively with Node.js 20+ or in the existing Docker deployment. The native deployment uses the same `worker/agent.mjs` runtime as the Controller host, wrapped by a dedicated per-device Scheduled Task and supervisor; no worker protocol fork is involved.

See [`worker/README.md`](worker/README.md) for native install/status/uninstall and Docker deployment details.

## Tool routing

The router adds `list_devices` and augments every ChatGPT-facing Desktop Commander worker tool with two WCM-only routing fields: required `deviceId` and optional `approval_id`. Example targets are `local-pc` and `remote-worker`. After resolving approval and device routing, the router removes both WCM-only fields, applies configured path mappings, and forwards only the original Desktop Commander business arguments to the worker. Desktop Commander's original tool implementations, worker-facing schemas, and worker protocol are not modified.

WCM has three local approval modes:

- `timed` (default): a routed worker-tool call **without** `approval_id` is frozen independently and returns `approval_required=true` with a fresh opaque `approval_id`. An unbound frozen action is valid for 15 minutes. Calling `request_approval` binds that ID to an approval card and starts a separate 3-day (72-hour) card-validity window. Its optional `duration_seconds` controls only that ID's post-approval full-WCM grant; omitting it requests 21600 seconds (6 hours). Approve starts the grant at approval time and dispatches only that ID's frozen owner action once. While the grant is active, pass that exact `approval_id` directly on later routed worker-tool calls to authorize them. Deny dispatches nothing. Different IDs never block, replace, or supersede one another, so multiple approved IDs may remain active concurrently with independent expiry times.
- `totp`: WCM worker tools and `uuyc_cli` require an active `approval_id`; missing authorization does **not** create an approval card. Exchange a six-digit code explicitly supplied by the user via `wcm_unlock` for a new full-WCM timed grant (default 6 hours; optionally 60–604800 seconds). Phones still generate a fresh standard TOTP code every 30 seconds, but both enrollment confirmation and WCM unlock accept approximately the last five minutes of codes (10 previous periods, the current period, and one future period for clock drift). Codes are single-use for WCM unlock, with a lightweight failed-attempt lockout. **Prefer CCM unless the user expressly asks to use WCM**, even when a valid WCM grant is known.
- `off`: routed tools execute directly without approval cards.

### Bind a phone authenticator on the 6v Controller

Any standard SHA-1 TOTP authenticator (2FAS, Microsoft Authenticator, Google Authenticator, etc.) supports this: six digits changing every 30 seconds. Use your own 6v local/UU terminal under the Windows account that runs the WCM Supervisor. The first command displays a Base32 secret **only in that terminal**; do not run it through model-operated tools:

`powershell.exe -NoProfile -File 'C:\Users\Songjx\Documents\ChatGPT\windows-console-mcp\scripts\manage-wcm-totp.ps1' -Action Init`

Manually add the displayed key to the phone as WCM (6v). Next, confirm a code and activate TOTP mode:

`powershell.exe -NoProfile -File 'C:\Users\Songjx\Documents\ChatGPT\windows-console-mcp\scripts\manage-wcm-totp.ps1' -Action Confirm -Code '123456'`

Replace `123456` with the live code. Until successful confirmation, WCM stays in its existing `timed` card mode. Use `-Action Status` without showing the secret. Only on deliberate re-pairing, use `-Action Reset`, which destroys the seed, revokes grants and requires fresh Init/Confirm. A permanent 20-byte seed is DPAPI CurrentUser-encrypted at `%LOCALAPPDATA%\WCM\secrets\totp.dpapi` (outside Git); replay state is stored alongside it. Reinstalling Windows or changing the Supervisor account may require re-pairing. Back up the seed privately if desired.

After deploying the Router, **Refresh tools** in the ChatGPT WCM plugin to expose `wcm_unlock`. This is a light accidental-use gate, not a hard isolation boundary against administrative host access.

`duration_seconds` is accepted by `request_approval` (in `timed` mode) and `wcm_unlock` (in `totp` mode), never by routed worker tools or the app-only resolver. Valid values are whole seconds from 60 through 604800 (7 days); common values are 60 (1 minute), 300 (5 minutes), 1800 (30 minutes), 3600 (1 hour), 21600 (6 hours, default), 86400 (1 day), and 604800 (7 days). In `timed` mode it is independent of card validity: a 60-second grant request still has the normal 3-day card window, and the grant clock starts only when the user approves. Once a card is bound, its requested duration cannot be changed and its hidden nonce is never reissued. Active grants are not extendable; request a new independent grant ID for a longer grant.

For grant reuse, call the original routed tool name and include the exact active `approval_id` alongside `deviceId` and the tool's normal business arguments. The Router accepts only a currently active, unexpired grant for that exact ID. Pending, denied, expired, revoked, superseded, or unknown IDs do not fall back to another grant and do not create a new approval. Because an approved grant is full-WCM access, the same active ID can authorize different real Desktop Commander tools and different registered devices until its own expiry. WCM never auto-selects an active grant.

Omitting `approval_id` in `timed` mode always requests another fresh independent approval, even while other IDs are active. `approval_status(approval_id)` performs a point lookup for an ID already known to the caller. `list_devices` exposes only aggregate pending/grant counts and nearest expiry information; it deliberately does not enumerate raw approval IDs because an approved ID is a bearer capability.

Request state and grant state are independent. For example, after approval the frozen owner action can be `consumed`, `approved_retryable`, or `execution_unknown` while that same ID's timed grant remains active. In-memory terminal requests and grants are retained for six hours (at most 1000 tombstones per store) for ordinary `approval_status` lookups. Separately, authenticated card-only terminal decision receipts persist under `logs/approval-receipts.json` for up to 90 days (at most 4096 records) so a previously finished card can show its decision after Router restart. The receipts store only minimal metadata, a hashed card nonce, and the optional bound Host session; they never restore pending requests, timed grants, worker commands, or access.

The local mode/revoke helper is:

```powershell
.\scripts\set-wcm-approval-mode.ps1 -Mode Timed
.\scripts\set-wcm-approval-mode.ps1 -Mode Off
.\scripts\set-wcm-approval-mode.ps1 -RevokeAll
.\scripts\set-wcm-approval-mode.ps1 -Status
```

`-RevokeAll` increments the local policy revision; the Router sees that revision change on the next gate/status check and supersedes all in-memory pending requests and revokes all active approval-id grants.

The ChatGPT-facing approval surface uses MCP Apps over the canonical `/rdc/mcp` endpoint. `request_approval` carries `ui.resourceUri`, `ui/resourceUri`, `openai/outputTemplate`, and `openai/widgetAccessible`. Both `resolve_pending_action` (the only mutating card operation) and `get_approval_status` (nonce- and Host-session-bound read-only verification) are app-only. The model-facing `approval_status` remains a separate ID-based diagnostic and cannot validate a reopened card.

The approval card is served at `ui://wcm/approval-v2.html` only; no historical UI alias is registered. It supports both `openai:set_globals` before initialization and tool-result notifications, then verifies state via `get_approval_status` after the `ui/initialize` handshake. A reopened or temporarily disconnected card may display a bounded, non-authoritative `window.openai.widgetState` terminal snapshot, but must disable decisions unless the authenticated Router state proves this specific card is still pending. A finished receipt never authorizes or replays its owner action; after Router restart previous timed grants are not active even when their historical card decision survives. On normal completion the View passes the result through `ui/update-model-context`, prefers standard `ui/message` continuation when available, and falls back to ChatGPT `sendFollowUpMessage`; failed continuation never retries an approved action.

The router also advertises bundled specialized capabilities in MCP discovery, `list_devices`, and `start_process` descriptions so an LLM can discover them without pretending that each helper is a standalone MCP action. The current catalog contains two capabilities: Bilibili download under `tools/bilibili-download` (including its bridge and bundled `yt-dlp.exe` fallback) and Quark transfer under `tools/quark-transfer`. Their READMEs remain the source of truth for invocation details and authentication requirements.

## Checks

> Coding agents: read [`AGENTS.md`](AGENTS.md) before running tests on a live WCM host.

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rdc-status.ps1
```

The `scripts/test-icon.mjs` case tests URL validation, PNG validation, public GET/HEAD responses, the missing-file case, continued OAuth enforcement on `/rdc/mcp`, and the plugin-upload asset's dimensions, format, transparency, and sub-10-KB size.

`npm test` is self-contained with respect to test data/config, but do not launch it through the same live WCM connection that is controlling this checkout: doing so can interrupt that worker/gateway transport and cause temporary HTTP 502s. Run it from an independent CCM/local terminal instead. The suite checks the approval card's remount/initialization and fail-closed behaviors, nonce-bound decision receipts and restart recovery, the frozen approval state machine and routing contracts, plus OAuth state pruning/caps, worker heartbeat expiry, and reconnect isolation.

To exercise an already configured live controller and sidecar, run:

```powershell
npm run test:live
npm run test:sdk
```

The live suite covers the canonical SDK Streamable HTTP endpoint, OAuth registration/PKCE/token refresh, the ChatGPT approval surface, timed/off routing behavior, device routing, the local approval UI resource, and session handling. It uses the configured OAuth deployment and can register test clients and exercise a real frozen approval flow on the target worker, so it is intentionally separate from the default CI test.

The public endpoint is configured by `RDC_RESOURCE`. With a Tailscale Funnel hostname it typically looks like:

```text
https://your-machine.your-tailnet.ts.net/rdc/mcp
```

`RDC_ISSUER` and `RDC_RESOURCE` are deployment-specific and are never hard-coded by the sidecar.

### ChatGPT tool refresh

After deploying Router changes, use **Refresh tools** in the ChatGPT plugin management panel to load the current MCP tool schemas. Verify that `restart_wcm`, `approval_status`, `request_approval`, and `resolve_pending_action` appear and that routed worker tools such as `get_config` and `start_process` accept optional `approval_id`. A conversation that retains an older tool snapshot may need a new conversation to see the updated list.

The Router-local `restart_wcm` tool takes no arguments and does not require WCM approval. It requests a controlled restart of the Controller's Router, local Worker, and OAuth sidecar through the Supervisor (not remote workers). Its `accepted` response means the request was queued, not that the restart has completed. The connection may briefly drop; verify the service health and device reconnection afterward. Repeated calls during a pending restart are deduplicated, and another restart within 60 seconds of completion is not scheduled. When the Supervisor is unavailable, the tool refuses the request.

## Troubleshooting

When a live WCM deployment behaves differently from the checked-out code, debug the runtime path before changing client configuration. The most common failure modes are stale processes, worker connection churn, or a tool-discovery request that never completed.

- **Code on disk is not proof that the live process reloaded it.** Compare the running router/worker PIDs and start times with the change you expect to be live. Then query the live SDK endpoint with `initialize`, `tools/list`, or the relevant tool call instead of inferring state from the checkout alone. After a restart, confirm that the PID changed and that `list_devices` works again.
- **A `tools/list` timeout can look like stale schema or client caching.** Inspect MCP BEGIN/END log pairs, session IDs, and elapsed time. If initialize succeeds but `tools/list` is missing an END record, is cancelled, or takes tens of seconds, fix that transport/runtime failure first. Once healthy, `tools/list` should normally complete quickly and consistently.
- **Only one active worker should own a given `deviceId`.** Duplicate or orphaned workers using the same ID can repeatedly replace each other's connection, causing reconnect loops and invalidating in-flight RPCs. Check worker-hub logs for frequent `Worker connected` messages and inspect process parentage. Keep the supervisor-owned worker and terminate stale/manual copies rather than starting another copy on top of them.
- **Large tool results are capped at the router boundary.** `tools/call` results larger than 512 KiB are replaced with a compact error before they reach the MCP client (`WC_MAX_TOOL_RESULT_BYTES` can override the limit). Large images are previewed at a 64 KiB raw budget, and `read_multiple_files` advertises a four-image batch limit to avoid cumulative media payload spikes.
- **Connection replacement should fail pending RPCs promptly.** A `Worker connection replaced` or `Worker disconnected` error is preferable to waiting for the full RPC timeout. Retry after the worker stabilizes; do not treat a long timeout as evidence that the requested tool is unsupported.
- **Debug the deployment layer by layer.** Test the public OAuth sidecar, local MCP router, worker hub, and worker separately. A healthy local router does not prove the public sidecar is forwarding successfully, and a healthy OAuth flow does not prove tool discovery succeeded. Use the per-layer ports from the architecture diagram and correlate requests with the logs.
- **Short transport failures are expected while restarting the process that carries the current tool call.** Killing or restarting the live router can make the triggering call end with HTTP 502 or `network_error` because its own transport disappeared. Wait for the supervisor to respawn the service, then verify a new PID and a successful `list_devices`/discovery call. Do not classify this as a WCM safety refusal.
- **Only the exact `Error: Command not allowed` marker is a WCM command-blocklist refusal.** Schema errors, quoting mistakes, command-not-found errors, non-zero exits, HTTP failures, `network_error`, and transient 502s should be debugged as ordinary runtime/transport failures.
- **Do not treat a single network/site failure as proof that WCM or a device is unavailable.** `Network is unreachable`, DNS failures, timeouts, connection resets, HTTP 403/404, and target-site verification/challenges can be transient or site-specific. Check `list_devices`, retry transient requests 2-3 times when appropriate, and use `curl` or another source when useful. Only conclude that WCM/device connectivity is unavailable when the device is reported offline or repeated harmless local WCM checks fail.
- **For slow network operations, separate process start from result collection.** Start the command with a short initial wait so the MCP call can return a PID/session, then use `read_process_output` to collect the result. This is more robust for operations such as remote pushes or downloads than keeping one MCP request open for the entire network operation.
- **Avoid manual parallel launches on a supervised controller.** Prefer the repository's supervisor/restart scripts. Manual router or worker instances are useful only on isolated test ports and must be cleaned up afterward. Before running disruptive tests, read `AGENTS.md` and avoid using the same live WCM transport that the test may restart.
- **Verify client-visible schema, not just tool count or tool names.** When testing discovery changes, inspect the actual `tools/list` descriptions, server instructions, resources, and tool metadata received by the SDK client. A normal tool count only proves the list was structurally available; it does not prove updated descriptions or instructions were loaded.
- **Keep unrelated worktree changes out of operational fixes.** Check `git status`, stage only the intended files, run `git diff --cached --check`, then commit and push. A live checkout often contains local experiments or runtime-only edits that should not be bundled into an unrelated repair.

## Security

WCM can execute commands and access files on registered devices. Expose only the OAuth-protected sidecar through your HTTPS ingress; keep the router and worker hubs private to localhost/Tailscale. Remote worker admission relies on the registered Tailscale source IP, so treat your tailnet and `config/devices.json` as part of the trust boundary.

The owner action is frozen server-side before the card is shown. The one-time approval nonce is delivered only in the tool result `_meta`, compared timing-safely, bound to the Host session when available, and never accepted as a replacement for the frozen action. Unbound action validity, bound-card validity, and post-approval grant duration are separate clocks. Pending approvals, retained terminal approval/grant state, and active grants are memory-only and are cleared by Router restart.

An approved `approval_id` is bearer authorization for its remaining lifetime, so Router status and routine audit logs do not enumerate raw active IDs. Approval audit records use a one-way SHA-256 fingerprint prefix for correlation instead. Timed WCM access skips only the Router approval gate; it does not bypass OAuth, device admission, registered-device routing, path mapping, Desktop Commander business validation, or Desktop Commander safety rules.

Secrets, OAuth state, worker-local configuration, runtime logs, and `node_modules` are excluded from Git. Never commit the generated `config/rdc.env`, `config/approval-policy.json`, `config/devices.json`, `config/worker-*.env`, or `.state/` contents.


## License

This repository is licensed under the MIT License. Third-party dependencies retain their own licenses and copyright notices.
