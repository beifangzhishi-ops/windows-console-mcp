# Windows Console MCP

Self-hosted multi-device Windows MCP controller for ChatGPT.

One controller owns the public OAuth/Funnel endpoint. Local and remote workers expose Desktop Commander through the controller with an explicit `deviceId` on every routed tool call.

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

The router adds `list_devices` and requires `deviceId` on every Desktop Commander tool. Example targets are `local-pc` and `remote-worker`.

## Checks

```powershell
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rdc-status.ps1
```

`npm test` runs both:

```text
legacy OAuth + stateful MCP E2E
MCP 2026-07-28 server/discover + stateless routing E2E
```

The public endpoint is configured by `RDC_RESOURCE`. With a Tailscale Funnel hostname it typically looks like:

```text
https://your-machine.your-tailnet.ts.net/rdc/mcp
```

`RDC_ISSUER` and `RDC_RESOURCE` are deployment-specific and are never hard-coded by the sidecar.

## Security

WCM can execute commands and access files on registered devices. Expose only the OAuth-protected sidecar through your HTTPS ingress; keep the router and worker hubs private to localhost/Tailscale. Remote worker admission relies on the registered Tailscale source IP, so treat your tailnet and `config/devices.json` as part of the trust boundary.

Secrets, OAuth state, worker-local configuration, runtime logs, and `node_modules` are excluded from Git. Never commit the generated `config/rdc.env`, `config/devices.json`, `config/worker-*.env`, or `.state/` contents.


## License

This repository is licensed under the MIT License. Third-party dependencies retain their own licenses and copyright notices.
