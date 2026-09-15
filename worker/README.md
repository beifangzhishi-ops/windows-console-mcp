# Windows Console Worker

A worker is a private execution node behind the Windows Console controller. It does not expose OAuth or Funnel endpoints.

## Requirements

- Tailscale joined to the controller's tailnet
- Docker Desktop on Windows
- The worker's Tailscale IPv4 registered in controller `config/devices.json`

The controller binds its remote Worker Hub directly to its own Tailscale IPv4 on TCP port `18100`. Each remote worker is authenticated by the real TCP source Tailscale IPv4, so remote workers do not need a shared secret.

## Windows Docker install

Run from the worker directory on the Windows host:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-docker-worker.ps1 `
  -DeviceId remote-worker `
  -ControllerHost 100.64.0.1
```

The installer creates a dedicated `windows-console-worker` container with `restart=unless-stopped`.

Default mounts:

```text
C:\            -> /host       read-only
workspace root  -> /workspace  read-write
worker dir      -> /app        read-write
```

Desktop Commander runs inside the worker container. Files outside those mounts are not exposed from the Windows host.

To remove the dedicated worker container:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall-docker-worker.ps1
```

Adding another worker follows the same model: install Tailscale, register its `deviceId` and Tailscale IPv4 on the controller, copy this worker directory, and run the installer with the new device ID.

## Media and response stability guards

The worker applies a compatibility patch to the pinned Desktop Commander 0.2.48 package after install and again before container startup.

The patch treats an image filename extension only as a candidate. Local images must also pass file-signature detection and decoder validation before they can be returned as MCP image content. Invalid or damaged image-like files fall back to the binary-file path instead of being blindly base64 encoded.

Large valid images are converted to a bounded WebP preview. The default raw inline-image budget is 128 KiB and can be overridden with `DESKTOP_COMMANDER_MAX_INLINE_IMAGE_BYTES` inside the worker environment.

The worker proxy also rejects oversized Desktop Commander JSON-RPC responses before forwarding them to the controller. The installer sets `WC_MAX_DC_RESPONSE_BYTES=524288` (512 KiB) by default.

Run the focused regression checks without starting or stopping the live gateway:

```powershell
cd worker
npm run test:stability
```

The patch is version-guarded. A future Desktop Commander upgrade must update and revalidate `patches/desktop-commander-image-guard.mjs` before deployment.
