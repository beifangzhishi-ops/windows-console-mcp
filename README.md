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

## Controller setup

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

`config/devices.json.example` shows the registry format. Local workers use a local token. Remote workers are bound to their registered Tailscale IPv4 and are accepted only on the controller's Tailscale-bound TCP listener.

## Remote workers

Remote workers do not run OAuth or Funnel. They connect directly to the Controller's Tailscale-bound worker hub.

Windows remote workers can run natively with Node.js 20+ or in the existing Docker deployment. The native deployment uses the same `worker/agent.mjs` runtime as the Controller host, wrapped by a dedicated per-device Scheduled Task and supervisor; no worker protocol fork is involved.

See [`worker/README.md`](worker/README.md) for native install/status/uninstall and Docker deployment details.

## Tool routing

The router adds `list_devices` and requires `deviceId` on every Desktop Commander worker tool. Example targets are `local-pc` and `remote-worker`. After resolving the target worker, the router removes its own `deviceId` routing argument, applies configured path mappings, and forwards the remaining business arguments directly to Desktop Commander.

WCM has two local approval modes:

- `timed` (default): when no active grant exists, the first routed tool call is frozen server-side and returns `approval_required=true` with an opaque `approval_id`. Call `request_approval` with that ID and an optional `duration_seconds`; omitting it requests 21600 seconds (6 hours). Approve grants the whole WCM Router instance timed access to all routed tools and registered devices, then dispatches only the frozen owner action once. Deny dispatches nothing. The grant is absolute, does not slide on use, lives only in Router memory, and disappears on expiry, revoke, policy change, or restart.
- `off`: routed tools execute directly without approval cards.

`duration_seconds` is accepted only by `request_approval`, not by ordinary worker tools or the app-only resolver. Valid values are whole seconds from 60 through 604800 (7 days). Once a card is bound, its duration cannot be changed and its hidden nonce is never reissued.

The local mode/revoke helper is:

```powershell
.\scripts\set-wcm-approval-mode.ps1 -Mode Timed
.\scripts\set-wcm-approval-mode.ps1 -Mode Off
.\scripts\set-wcm-approval-mode.ps1 -RevokeAll
.\scripts\set-wcm-approval-mode.ps1 -Status
```

`-RevokeAll` increments the local policy revision; the Router sees that revision change on the next gate/status check and clears any in-memory pending request and active grant.

The ChatGPT-facing approval surface follows the currently working CCM wire contract: approval tools and the approval resource are ordinary MCP tools/resources without a separate UI capability negotiation layer. `request_approval` carries `ui.resourceUri`, `ui/resourceUri`, `openai/outputTemplate`, and `openai/widgetAccessible`; `resolve_pending_action` is app-only and widget-accessible. The only public MCP endpoint is the canonical `/rdc/mcp`.

The approval View is one static `String.raw` HTML document intentionally kept structurally aligned with CCM's current working approval View. It uses the same classic inline-script layout, `ui/initialize` / `ui/notifications/initialized` lifecycle, tool-result notifications, `tools/call`, `ui/update-model-context`, and ChatGPT `window.openai` globals (`toolResponseMetadata`, `toolOutput`, `openai:set_globals`, intrinsic-height notification, and follow-up continuation). The resource path is fixed at `ui://wcm/approval-v1.html`, matching CCM's fixed-URI pattern while keeping the WCM namespace distinct.

The router also advertises bundled specialized capabilities in MCP discovery, `list_devices`, and `start_process` descriptions so an LLM can discover them without pretending that each helper is a standalone MCP action. The current catalog contains two capabilities: Bilibili download under `tools/bilibili-download` (including its bridge and bundled `yt-dlp.exe` fallback) and Quark transfer under `tools/quark-transfer`. Their READMEs remain the source of truth for invocation details and authentication requirements.

## Checks

> Coding agents: read [`AGENTS.md`](AGENTS.md) before running tests on a live WCM host.

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rdc-status.ps1
```

`npm test` is self-contained with respect to test data/config, but do not launch it through the same live WCM connection that is controlling this checkout: doing so can interrupt that worker/gateway transport and cause temporary HTTP 502s. Run it from an independent local terminal instead. It validates the CCM-aligned static approval View, checks the frozen approval state machine and routing contracts, and covers OAuth state pruning/caps, worker heartbeat expiry, and reconnect isolation.

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

### ChatGPT rebuild handoff rule

When the ChatGPT WCM registration needs to be rebuilt, provide the current public MCP resource from `RDC_RESOURCE` and the following absolute-path PowerShell command so the user can print the current WCM key and URL locally:

```powershell
$wcmKey = (Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\windows-console-mcp\.state\rdc-approval-secret.txt' -Raw).Trim()
$wcmUrl = ((Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\windows-console-mcp\config\rdc.env' | Where-Object { $_ -match '^RDC_RESOURCE=' } | Select-Object -First 1) -replace '^RDC_RESOURCE=', '').Trim().Trim('"')
Write-Output ("WCM key: " + $wcmKey)
Write-Output ("WCM URL: " + $wcmUrl)
```

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

The owner action is frozen server-side before the card is shown. The one-time approval nonce is delivered only in the tool result `_meta`, compared timing-safely, bound to the Host session when available, and never accepted as a replacement for the frozen action. Pending approval and active grants are memory-only. Timed WCM access skips only the Router approval gate; it does not bypass OAuth, device admission, registered-device routing, or Desktop Commander safety rules.

Secrets, OAuth state, worker-local configuration, runtime logs, and `node_modules` are excluded from Git. Never commit the generated `config/rdc.env`, `config/approval-policy.json`, `config/devices.json`, `config/worker-*.env`, or `.state/` contents.


## License

This repository is licensed under the MIT License. Third-party dependencies retain their own licenses and copyright notices.
