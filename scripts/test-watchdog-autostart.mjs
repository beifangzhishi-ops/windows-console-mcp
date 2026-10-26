import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'install-diagnostics-watchdog.ps1'), 'utf8');

test('watchdog autostart uses hidden WScript and keeps the gateway independent', () => {
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /sh\.Run\("[^\r\n]+", 0, True\)/);
  assert.match(script, /-WindowStyle Hidden/);
  assert.match(script, /New-ScheduledTaskAction -Execute "[^"]*\\wscript\.exe"/);
  assert.match(script, /Set-ScheduledTask -TaskName \$taskName -Action \$action/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.doesNotMatch(script, /Stop-ScheduledTask|Restart-Service|Stop-Process/);
  assert.doesNotMatch(script, /Desktop Commander Selfhost Gateway/);
});
