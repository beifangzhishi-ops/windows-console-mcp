import assert from 'node:assert/strict';
import test from 'node:test';
import { UuCliRunner, validateUuCliArgs } from '../router/uu-cli.mjs';

function fakeHarness() {
  const processes = [];
  const runner = new UuCliRunner({
    executable: () => 'uuyc-cli.exe',
    spawn(exe, args) {
      const p = {
        exe, args, writes: [], killed: false,
        onData(fn) { this.dataHandler = fn; },
        onExit(fn) { this.exitHandler = fn; },
        write(data) { this.writes.push(data); },
        emitData(data) { this.dataHandler?.(data); },
        emitExit(exitCode = 0) { this.exitHandler?.({ exitCode }); },
        kill() { this.killed = true; this.emitExit(0); },
      };
      processes.push(p);
      return p;
    },
  });
  return { processes, runner };
}

test('native CLI args and WCM approval validation', async () => {
  const { runner, processes } = fakeHarness();
  assert.throws(() => validateUuCliArgs({ close: true, args: [] }));
  const first = await runner.execute({ args: ['device', 'ls'], timeout_ms: 0 }, { approvalId: 'A' });
  assert.deepEqual(processes[0].args, ['device', 'ls']);
  await assert.rejects(() => runner.execute({ session_id: first.session_id, stdin: 'hello' }, { approvalId: 'B' }));
  assert.equal(processes[0].writes.length, 0);
  await runner.execute({ session_id: first.session_id, stdin: 'hostname\r', timeout_ms: 0 }, { approvalId: 'A' });
  assert.deepEqual(processes[0].writes, ['hostname\r']);
  processes[0].emitData('noha\r\n');
  processes[0].emitExit(0);
  const done = await runner.execute({ session_id: first.session_id, timeout_ms: 0 }, { approvalId: 'A' });
  assert.match(done.output, /noha/);
  assert.equal(done.exit_code, 0);
});

test('grant expiration and policy change kill active terminals', async () => {
  const { runner, processes } = fakeHarness();
  await runner.execute({ args: ['term', 'new'], timeout_ms: 0 }, {
    approvalId: 'A', expiresAt: new Date(Date.now() + 70).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processes[0].killed, true);
  await runner.execute({ args: ['term', 'new'], timeout_ms: 0 });
  runner.closeAll('policy_changed');
  assert.equal(processes[1].killed, true);
});
