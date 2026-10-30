import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_SESSIONS = 8;
const MAX_SESSION_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 3000;
const MAX_WAIT_MS = 20000;

export const UU_CLI_TOOL = {
  name: 'uuyc_cli',
  description: [
    'Run the official UU Remote uuyc-cli.exe on the 6v WCM Controller. Pass native UU CLI tokens in args, e.g. ["device", "ls", "--json"] or ["term", "-d", "<UU device ID>", "new", "name"].',
    'Commands run inside a real Windows ConPTY terminal; the remote computer only needs UU Remote installed and logged in. On a running session, pass session_id with optional stdin (including carriage returns), or close=true. All invocations, including reads/writes to live sessions, require the same WCM timed full-access approval_id; there is no separate UU authorization.',
    'The output is raw terminal text (including possible ANSI escape sequences). A running process returns session_id for subsequent calls. Do not confuse UU device IDs in args with WCM deviceId. A UU remote desktop session may block terminal access with error 127.',
  ].join('\n\n'),
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, maxItems: 64,
        description: 'Native uuyc-cli.exe argument tokens; omit when continuing a session.' },
      session_id: { type: 'string', format: 'uuid', description: 'Continue one UU CLI terminal session.' },
      stdin: { type: 'string', maxLength: 32768,
        description: 'Input sent verbatim to the PTY, e.g. "hostname\\r".' },
      close: { type: 'boolean', description: 'Stop this session and clean up its local PTY.' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS,
        description: 'Wait for new terminal output or exit, max 20 seconds; defaults to 3 seconds.' },
      approval_id: { type: 'string', format: 'uuid',
        description: 'Existing WCM timed full-access approval ID. Omit to request the standard WCM approval card.' },
    },
    additionalProperties: false,
  },
};

export function validateUuCliArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('uuyc_cli arguments must be an object.');
  const { args, session_id, stdin, close, timeout_ms } = value;
  if (session_id != null && (typeof session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(session_id))) throw new Error('Invalid UU session_id.');
  if (session_id == null && !Array.isArray(args)) throw new Error('Either args or session_id is required.');
  if (session_id != null && args != null) throw new Error('Supply args or session_id, not both.');
  if (args != null && (args.length > 64 || args.some((item) => typeof item !== 'string' || item.length > 4096 || item.includes('\0')))) throw new Error('args must contain at most 64 valid strings.');
  if (stdin != null && (typeof stdin !== 'string' || stdin.length > 32768)) throw new Error('stdin is too long or invalid.');
  if (close != null && typeof close !== 'boolean') throw new Error('close must be boolean.');
  if (close && session_id == null) throw new Error('close requires session_id.');
  if (timeout_ms != null && (!Number.isInteger(timeout_ms) || timeout_ms < 0 || timeout_ms > MAX_WAIT_MS)) throw new Error('Invalid timeout_ms.');
  return { args, session_id, stdin, close, timeout_ms: timeout_ms ?? DEFAULT_WAIT_MS };
}

function defaultExecutable() {
  if (process.platform !== 'win32') throw new Error('UU CLI is only supported on a Windows WCM Controller.');
  const candidate = process.env.WC_UU_CLI_PATH || path.join(
    process.env.ProgramFiles || 'C:\\Program Files', 'Netease', 'GameViewer', 'bin', 'uuyc-cli.exe',
  );
  if (!fs.existsSync(candidate)) throw new Error('UU CLI executable not found: ' + candidate);
  return candidate;
}

function defaultSpawn(executable, args) {
  const pty = require('@lydell/node-pty');
  return pty.spawn(executable, args, {
    name: 'xterm-256color', cols: 120, rows: 35,
    cwd: process.cwd(), env: process.env,
  });
}

export class UuCliRunner {
  constructor({ spawn = defaultSpawn, executable = defaultExecutable, now = () => Date.now() } = {}) {
    this.spawn = spawn;
    this.executable = executable;
    this.now = now;
    this.sessions = new Map();
  }

  stop(session, reason = 'closed') {
    if (session.terminalReason) return;
    session.terminalReason = reason;
    session.exited = true;
    session.exit_code = null;
    clearTimeout(session.expiryTimer);
    try { session.process.kill(); } catch {}
    session.wake?.();
  }

  closeAll(reason = 'policy_changed') {
    for (const session of this.sessions.values()) this.stop(session, reason);
    this.sessions.clear();
  }

  prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() >= session.deadline || (session.exited && this.now() - session.lastAccess > 60000)) {
        this.stop(session, session.terminalReason || 'session_expired');
        this.sessions.delete(id);
      }
    }
  }

  async execute(input, { approvalId = null, expiresAt = null } = {}) {
    const request = validateUuCliArgs(input);
    this.prune();
    let session;
    if (request.session_id != null) {
      session = this.sessions.get(request.session_id);
      if (!session) throw new Error('UU CLI session is unknown or expired.');
      if (session.approvalId !== approvalId) throw new Error('UU CLI session belongs to a different WCM approval_id.');
      if (request.close) {
        this.stop(session);
        this.sessions.delete(request.session_id);
        return { status: 'closed', session_id: request.session_id, output: '' };
      }
      if (request.stdin && !session.exited) session.process.write(request.stdin);
    } else {
      if (this.sessions.size >= MAX_SESSIONS) throw new Error('Too many UU CLI sessions; close an existing session first.');
      const id = randomUUID();
      const started = this.now();
      const grantDeadline = expiresAt ? Date.parse(expiresAt) : Infinity;
      const deadline = Math.min(started + MAX_SESSION_MS, grantDeadline);
      if (deadline <= started) throw new Error('WCM grant has already expired.');
      const proc = this.spawn(this.executable(), request.args);
      session = {
        id, process: proc, approvalId, lastAccess: started, deadline,
        buffer: '', dropped: false, exited: false, exit_code: null,
        terminalReason: null, expiryTimer: null, wake: null,
      };
      proc.onData((data) => {
        session.buffer += String(data);
        if (session.buffer.length > MAX_OUTPUT_CHARS) {
          session.buffer = session.buffer.slice(-MAX_OUTPUT_CHARS);
          session.dropped = true;
        }
        session.wake?.();
      });
      proc.onExit(({ exitCode }) => {
        if (!session.terminalReason) session.exit_code = exitCode;
        session.exited = true;
        clearTimeout(session.expiryTimer);
        session.wake?.();
      });
      session.expiryTimer = setTimeout(() => this.stop(session, 'grant_or_session_expired'), deadline - started);
      session.expiryTimer.unref?.();
      this.sessions.set(id, session);
      if (request.stdin) proc.write(request.stdin);
    }
    session.lastAccess = this.now();
    await this.waitForOutput(session, request.timeout_ms);
    session.lastAccess = this.now();
    const output = session.buffer;
    const truncated = session.dropped;
    session.buffer = '';
    session.dropped = false;
    const result = {
      status: session.exited ? 'exited' : 'running',
      session_id: session.id, output, truncated,
      exit_code: session.exited ? session.exit_code : null,
      ...(session.terminalReason ? { reason: session.terminalReason } : {}),
    };
    if (session.exited) this.sessions.delete(session.id);
    return result;
  }

  async waitForOutput(session, timeoutMs) {
    if (session.exited || timeoutMs === 0) return;
    await new Promise((resolve) => {
      let idleTimer;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(idleTimer);
        if (session.wake === wake) session.wake = null;
        resolve();
      };
      const wake = () => {
        if (session.exited) return finish();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 350);
      };
      const timeoutTimer = setTimeout(finish, timeoutMs);
      session.wake = wake;
      if (session.buffer) wake();
    });
  }
}
