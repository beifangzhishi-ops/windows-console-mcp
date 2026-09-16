# Agent Notes

## Test safety on the live WCM host

- Read this before running repository tests from ChatGPT/WCM.
- `npm test` is self-contained with respect to test data/config, but do **not** launch it through the same live WCM connection that is controlling this checkout.
- In practice, running `npm test` from the active WCM session can interrupt the worker/gateway transport and make subsequent WCM tool calls return HTTP 502 until the gateway reconnects or is restarted.
- This 502 is an operational/self-hosting failure, not a WCM command-blocklist rejection.
- Prefer running `npm test` from an independent local PowerShell/terminal outside the active WCM control path. If that is unavailable, run only the smallest targeted test needed and avoid tests that spawn/tear down gateway-like worker processes.
- Do not restart or stop the live gateway from inside its own WCM session unless an independent recovery path is already available.

## WCM error semantics

- Only a result explicitly classified as `WCM classification: command_blocked`, originating from the exact upstream marker `Error: Command not allowed`, means the WCM command blocklist rejected the command.
- Schema/argument errors, path errors, command-not-found errors, non-zero exits, HTTP 502, worker disconnects, and runtime/process failures are not command-blocklist rejections.
- A single network/site error such as `Network is unreachable`, DNS failure, timeout, connection reset, HTTP 403/404, or target-site verification/challenge does not mean WCM or the target device is unavailable. Check `list_devices`, retry transient network requests 2-3 times when appropriate, and only conclude WCM/device connectivity is unavailable when the device is reported offline or repeated harmless local WCM checks fail.
