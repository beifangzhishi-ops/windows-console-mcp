# Windows Console MCP

Self-hosted multi-device Windows MCP controller for ChatGPT.

One controller owns the public OAuth/Funnel endpoint. Local and remote workers expose Desktop Commander through the controller with an explicit `deviceId` and a device-bound temporary `permissionId` on every routed worker tool call.

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

The controller supports both legacy stateful MCP and stateless MCP `2026-07-28` with `server/discover`.

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

Remote workers do not run OAuth or Funnel. They need Tailscale and Docker Desktop on the worker Windows host.

See [`worker/README.md`](worker/README.md) for the dedicated Docker worker installer.

## Tool routing

The router adds `list_devices` and requires both `deviceId` and a matching temporary `permissionId` on every Desktop Commander worker tool. Example targets are `local-pc` and `remote-worker`.

Temporary permissions are approved explicitly in the WCM approval card and are bound to one device. The normal flow is:

1. Call `list_devices` to identify the target.
2. Call `request_temporary_permission` with that `deviceId`.
3. The user approves or denies the request in the WCM approval card.
4. Approval returns a new `permissionId`. Use it only with the same `deviceId`.
5. The permission remains valid for at most six hours from the approval time. It is not automatically renewed.
6. Call `revoke_temporary_permission` to invalidate it early, or request a new permission after expiry.

`list_devices`, `request_temporary_permission`, `temporary_permission_status`, and `revoke_temporary_permission` are router-owned and do not themselves require a temporary permission. The approval resolver is also router-owned but is advertised as an MCP-App-only action rather than a model-facing approval path. The public `approval_id` is not an execution credential: approval also requires a hidden per-request nonce supplied only in the tool-result `_meta` for the approval App, and the actual `permissionId` is generated only after the App resolves the frozen request.

Each approval request also receives an `operation_id` and `intent_sha256`. The router freezes the exact device, grant duration, and permission scope when the request is created. The approval App may submit only the `approval_id`, hidden nonce, and decision; it cannot replace the frozen target. When the host supplies `openai/session`, the request is bound to that host session and a different session cannot consume it. Successful approval moves the request through `dispatching` to `consumed`; a failure before permission issuance may remain `approved_retryable`, while an indeterminate post-dispatch outcome is never retried automatically. The approval App writes the terminal result back with `ui/update-model-context` and asks ChatGPT to continue without recreating the approval action.

Approved permission state is stored under `.state/wcm-temporary-permissions.json` so a router restart does not silently revoke a still-valid six-hour grant. Only a SHA-256 hash of the bearer capability is persisted; the plaintext `permissionId` is never written to that state file or router audit log. Pending approval requests are memory-only and expire after 15 minutes by default.

The supervisor reads `WC_TEMP_PERMISSION_TTL_SECONDS` and `WC_PERMISSION_APPROVAL_TTL_SECONDS` from `config/rdc.env` when present. Defaults are 21600 seconds (six hours) and 900 seconds (15 minutes), respectively. The router caps active permission TTL at six hours even if a larger value is configured.

The router also advertises bundled specialized capabilities in MCP discovery, `list_devices`, and `start_process` descriptions so an LLM can discover them without pretending that each helper is a standalone MCP action. The current catalog contains two capabilities: Bilibili download under `tools/bilibili-download` (including its bridge and bundled `yt-dlp.exe` fallback) and Quark transfer under `tools/quark-transfer`. Their READMEs remain the source of truth for invocation details and authentication requirements.

## Checks

> Coding agents: read [`AGENTS.md`](AGENTS.md) before running tests on a live WCM host.

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rdc-status.ps1
```

`npm test` is self-contained with respect to test data/config, but do not launch it through the same live WCM connection that is controlling this checkout: doing so can interrupt that worker/gateway transport and cause temporary HTTP 502s. Run it from an independent local terminal instead. It covers temporary-permission issuance/expiry/revocation/persistence, OAuth state pruning/caps, worker heartbeat expiry, and reconnect isolation.

To exercise an already configured live controller and sidecar, run:

```powershell
npm run test:live
```

The live suite covers legacy OAuth/stateful MCP, MCP `2026-07-28`, temporary-permission request/approval/revocation, device routing, resources, and duplicate external JSON-RPC IDs. It uses the configured OAuth deployment and can register test clients and short-lived WCM permissions, so it is intentionally separate from the default CI test.

The public endpoint is configured by `RDC_RESOURCE`. With a Tailscale Funnel hostname it typically looks like:

```text
https://your-machine.your-tailnet.ts.net/rdc/mcp
```

`RDC_ISSUER` and `RDC_RESOURCE` are deployment-specific and are never hard-coded by the sidecar.

## Troubleshooting

When a live WCM deployment behaves differently from the checked-out code, debug the runtime path before changing client configuration. The most common failure modes are stale processes, worker connection churn, or a tool-discovery request that never completed.

- **Code on disk is not proof that the live process reloaded it.** Compare the running router/worker PIDs and start times with the change you expect to be live. Then query the live router directly (`server/discover`, `tools/list`, or the relevant tool call) instead of inferring state from the checkout alone. After a restart, confirm that the PID changed and that `list_devices` works again.
- **OAuth reconnect and tool-schema refresh are separate events.** Reconnecting a client can refresh credentials without causing it to request `server/discover` or `tools/list` again. Use sidecar logs to verify that a discovery/list request actually arrived and completed. If the server response is current but an existing chat still shows an older schema, test with a fresh client/session before changing the server again.
- **A `tools/list` timeout can look like stale schema or client caching.** Inspect MCP BEGIN/END log pairs and elapsed time. If `server/discover` succeeds but `tools/list` is missing an END record, is cancelled, or takes tens of seconds, fix that transport/runtime failure first. Once healthy, `tools/list` should normally complete quickly and consistently.
- **Only one active worker should own a given `deviceId`.** Duplicate or orphaned workers using the same ID can repeatedly replace each other's connection, causing reconnect loops and invalidating in-flight RPCs. Check worker-hub logs for frequent `Worker connected` messages and inspect process parentage. Keep the supervisor-owned worker and terminate stale/manual copies rather than starting another copy on top of them.
- **Large tool results are capped at the router boundary.** `tools/call` results larger than 512 KiB are replaced with a compact error before they reach the MCP client (`WC_MAX_TOOL_RESULT_BYTES` can override the limit). Large images are previewed at a 64 KiB raw budget, and `read_multiple_files` advertises a four-image batch limit to avoid cumulative media payload spikes.
- **Connection replacement should fail pending RPCs promptly.** A `Worker connection replaced` or `Worker disconnected` error is preferable to waiting for the full RPC timeout. Retry after the worker stabilizes; do not treat a long timeout as evidence that the requested tool is unsupported.
- **Debug the deployment layer by layer.** Test the public OAuth sidecar, local MCP router, worker hub, and worker separately. A healthy local router does not prove the public sidecar is forwarding successfully, and a healthy OAuth flow does not prove tool discovery succeeded. Use the per-layer ports from the architecture diagram and correlate requests with the logs.
- **Short transport failures are expected while restarting the process that carries the current tool call.** Killing or restarting the live router can make the triggering call end with HTTP 502 or `network_error` because its own transport disappeared. Wait for the supervisor to respawn the service, then verify a new PID and a successful `list_devices`/discovery call. Do not classify this as a WCM safety refusal.
- **Only the exact `Error: Command not allowed` marker is a WCM command-blocklist refusal.** Schema errors, quoting mistakes, command-not-found errors, non-zero exits, HTTP failures, `network_error`, and transient 502s should be debugged as ordinary runtime/transport failures.
- **Do not treat a single network/site failure as proof that WCM or a device is unavailable.** `Network is unreachable`, DNS failures, timeouts, connection resets, HTTP 403/404, and target-site verification/challenges can be transient or site-specific. Check `list_devices`, retry transient requests 2-3 times when appropriate, and use `curl` or another source when useful. Only conclude that WCM/device connectivity is unavailable when the device is reported offline or repeated harmless local WCM checks fail.
- **For slow network operations, separate process start from result collection.** Start the command with a short initial wait so the MCP call can return a PID/session, then use `read_process_output` to collect the result. This is more robust for operations such as remote pushes or downloads than keeping one MCP request open for the entire network operation.
- **Avoid manual parallel launches on a supervised controller.** Prefer the repository's supervisor/restart scripts. Manual router or worker instances are useful only on isolated test ports and must be cleaned up afterward. Before running disruptive tests, read `AGENTS.md` and avoid using the same live WCM transport that the test may restart.
- **Verify client-visible schema, not just tool count or tool names.** When testing discovery changes, inspect the actual `tools/list` descriptions and `server/discover.instructions` received by the client. A normal tool count only proves the list was structurally available; it does not prove updated descriptions or instructions were loaded.
- **Keep unrelated worktree changes out of operational fixes.** Check `git status`, stage only the intended files, run `git diff --cached --check`, then commit and push. A live checkout often contains local experiments or runtime-only edits that should not be bundled into an unrelated repair.

## Security

WCM can execute commands and access files on registered devices. Expose only the OAuth-protected sidecar through your HTTPS ingress; keep the router and worker hubs private to localhost/Tailscale. Remote worker admission relies on the registered Tailscale source IP, so treat your tailnet and `config/devices.json` as part of the trust boundary.

Temporary `permissionId` values are bearer capabilities. Do not paste them into logs, source files, tickets, or other persistent storage. WCM audit records use only a short hash fingerprint, and persisted grant records contain only the full hash plus device/timing metadata.

Secrets, OAuth state, temporary-permission state, worker-local configuration, runtime logs, and `node_modules` are excluded from Git. Never commit the generated `config/rdc.env`, `config/devices.json`, `config/worker-*.env`, or `.state/` contents.


## License

This repository is licensed under the MIT License. Third-party dependencies retain their own licenses and copyright notices.
