import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, '..');
const read = (name) => fs.readFileSync(path.join(workerDir, name), 'utf8');

const install = read('install-native-worker.ps1');
const supervisor = read('native-worker-supervisor.ps1');
const uninstall = read('uninstall-native-worker.ps1');
const status = read('status-native-worker.ps1');
const readProjectFile = (name) => fs.readFileSync(path.resolve(workerDir, '..', name), 'utf8');
const gatewayInstall = readProjectFile('scripts/install-rdc-autostart.ps1');
const watchdogInstall = readProjectFile('scripts/install-diagnostics-watchdog.ps1');

assert.match(install, /Node\.js 20 or newer/u);
assert.match(install, /Register-ScheduledTask/u);
assert.match(install, /whoami\.exe/u);
assert.match(install, /New-ScheduledTaskPrincipal -UserId \$taskUser/u);
assert.match(install, /#Requires -RunAsAdministrator/u);
assert.match(install, /New-ScheduledTaskPrincipal -UserId \$taskUser -LogonType Interactive -RunLevel Highest/u);
assert.match(gatewayInstall, /#Requires -RunAsAdministrator/u);
assert.match(gatewayInstall, /\$taskUser=\[string\]\(& whoami\.exe/u);
assert.match(gatewayInstall, /New-ScheduledTaskTrigger -AtLogOn -User \$taskUser/u);
assert.match(gatewayInstall, /New-ScheduledTaskPrincipal -UserId \$taskUser -LogonType Interactive -RunLevel Highest/u);
assert.match(watchdogInstall, /New-ScheduledTaskPrincipal[^\r\n]*-RunLevel Limited/u);
assert.match(install, /MultipleInstances IgnoreNew/u);
assert.match(install, /Connected to controller as/u);
assert.match(install, /WC_DC_SCRIPT=\$dc/u);
assert.doesNotMatch(install, /\/host|\/workspace|docker\.exe/u);
assert.match(supervisor, /WindowsConsoleNativeWorker-/u);
assert.match(supervisor, /agent\.mjs/u);
assert.match(supervisor, /taskkill\.exe/u);
assert.match(uninstall, /Skipping stale PID/u);
assert.match(uninstall, /Unregister-ScheduledTask/u);
assert.match(status, /Recent agent stdout/u);

console.log('Native worker template smoke checks passed.');
