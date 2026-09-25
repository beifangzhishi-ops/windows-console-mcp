# Windows Console Worker

A worker is a private execution node behind the Windows Console controller. It does not expose OAuth or Funnel endpoints.

The controller binds its remote Worker Hub to its Tailscale IPv4 on TCP port `18100`. Remote workers are admitted by their registered Tailscale source IPv4, so they do not use a shared worker secret.

## Requirements

- Tailscale joined to the controller's tailnet
- The worker's Tailscale IPv4 registered in controller `config/devices.json`
- Native Windows deployment: Node.js 20 or newer
- Docker deployment: Docker Desktop

## Native Windows worker

The native deployment runs the same `agent.mjs` used by the Controller host. The installer performs the pinned `npm ci`, writes a local-only Windows `worker.env`, registers a per-device hidden Scheduled Task, and starts `native-worker-supervisor.ps1`. The supervisor keeps exactly one matching agent alive and restarts it after failure.

Install:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\windows-console-mcp\worker\install-native-worker.ps1 `
  -DeviceId remote-worker `
  -ControllerHost 100.64.0.1
```

Check local task/process/log state:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\windows-console-mcp\worker\status-native-worker.ps1 `
  -DeviceId remote-worker
```

Uninstall the native task and its generated local state:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\windows-console-mcp\worker\uninstall-native-worker.ps1 `
  -DeviceId remote-worker
```

Generated configuration is stored under `config/worker-native-<deviceId>.env`; PID/launcher state is under `.state/`, and runtime logs are under `logs/`. These paths are excluded from Git.

For a native worker, Controller-side `pathMappings` must reflect native Windows paths. Do not retain Docker mappings such as `C:\ -> /host`. Because the Router loads `config/devices.json` at startup, changing path mappings requires a controlled Router restart.

Do not start a native worker while another worker with the same `deviceId` is connected. Cut over by stopping the old worker first, starting the native task, and verifying that the Controller reports exactly one online device.

## Docker worker

The Docker deployment remains available when host filesystem isolation is desired:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\windows-console-mcp\worker\install-docker-worker.ps1 `
  -DeviceId remote-worker `
  -ControllerHost 100.64.0.1
```

The Docker installer creates a dedicated `windows-console-worker` container with `restart=unless-stopped`. Its default mounts are `C:\ -> /host` read-only, the configured workspace root -> `/workspace` read-write, and the worker directory -> `/app` read-write.

Remove that container with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\windows-console-mcp\worker\uninstall-docker-worker.ps1
```

## Media and response stability guards

Both deployments use the pinned Desktop Commander 0.2.48 package and apply `patches/desktop-commander-image-guard.mjs` during dependency installation.

The patch validates image signatures and decoding before returning inline image content. Invalid image-like files fall back to binary-file handling. Large valid images are converted to bounded WebP previews. The default raw inline-image budget is 64 KiB and can be overridden with `DESKTOP_COMMANDER_MAX_INLINE_IMAGE_BYTES`.

Desktop Commander stdout is guarded before JSON-RPC leaves the child process. Complete guarded responses larger than 512 KiB are replaced with a compact `-32099` error; `DESKTOP_COMMANDER_MAX_STDOUT_JSON_BYTES` and `WC_MAX_DC_RESPONSE_BYTES` control the two response limits.

Run focused worker regression checks from an independent terminal:

```powershell
Set-Location -LiteralPath C:\path\to\windows-console-mcp\worker
npm.cmd run test:stability
```

Do not run disruptive live gateway tests through the same WCM connection that is carrying the current session.
