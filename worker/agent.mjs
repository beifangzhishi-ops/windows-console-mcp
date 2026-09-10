import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

function parseEnv(content) {
  const out = {};
  for (const raw of String(content).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

function loadEnv() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const fromFile = file && fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = loadEnv();
const deviceId = String(env.WC_DEVICE_ID || '').trim();
const deviceName = String(env.WC_DEVICE_NAME || deviceId).trim();
const controllerHost = String(env.WC_CONTROLLER_HOST || '').trim();
const controllerPort = Number(env.WC_CONTROLLER_PORT || 18100);
const workerToken = String(env.WC_WORKER_TOKEN || '');
const dcNode = String(env.WC_DC_NODE || process.execPath);
const dcScript = path.resolve(String(env.WC_DC_SCRIPT || ''));
const reconnectMs = Number(env.WC_RECONNECT_MS || 3000);

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(deviceId)) throw new Error('Invalid WC_DEVICE_ID.');
if (!controllerHost) throw new Error('WC_CONTROLLER_HOST is required.');
if (!Number.isInteger(controllerPort) || controllerPort < 1 || controllerPort > 65535) throw new Error('Invalid WC_CONTROLLER_PORT.');
if (workerToken && workerToken.length < 32) throw new Error('WC_WORKER_TOKEN is too short.');
if (!dcScript || !fs.existsSync(dcScript)) throw new Error('WC_DC_SCRIPT was not found: ' + dcScript);

let child = null;
let socket = null;
let connected = false;
let stopping = false;
let inputBuffer = '';
const pendingByRpcId = new Map();
let nextWorkerRpcSequence = 0;

function rpcKey(id) {
  return typeof id + ':' + JSON.stringify(id);
}

function allocateWorkerRpcId() {
  nextWorkerRpcSequence += 1;
  return `wc-worker-${process.pid}-${nextWorkerRpcSequence}`;
}

function writeFrame(value) {
  if (socket && !socket.destroyed) socket.write(JSON.stringify(value) + '\n');
}
function startDesktopCommander() {
  child = spawn(dcNode, [dcScript], {
    cwd: path.dirname(dcScript),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' },
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); }
    catch { return; }
    if (message?.id === undefined || message?.id === null) return;
    const key = rpcKey(message.id);
    const pending = pendingByRpcId.get(key);
    if (!pending) return;
    pendingByRpcId.delete(key);
    writeFrame({
      type: 'response',
      requestId: pending.requestId,
      message: { ...message, id: pending.originalRpcId },
    });
  });
  child.stderr.on('data', (chunk) => process.stderr.write('[desktop-commander] ' + chunk.toString('utf8')));
  child.on('exit', () => {
    for (const pending of pendingByRpcId.values()) {
      writeFrame({ type: 'response', requestId: pending.requestId, error: 'Desktop Commander exited.' });
    }
    pendingByRpcId.clear();
    if (!stopping) setTimeout(startDesktopCommander, 2000);
  });
}
function sendToDesktopCommander(frame) {
  if (!child || child.killed || !child.stdin.writable) {
    if (frame?.type === 'request') {
      writeFrame({ type: 'response', requestId: frame.requestId, error: 'Desktop Commander is unavailable.' });
    }
    return;
  }
  const payload = frame?.payload;
  if (!payload || typeof payload !== 'object') return;
  let outbound = payload;
  if (frame.type === 'request') {
    if (payload.id === undefined || payload.id === null) {
      writeFrame({ type: 'response', requestId: frame.requestId, error: 'Worker requests require a JSON-RPC id.' });
      return;
    }
    const workerRpcId = allocateWorkerRpcId();
    pendingByRpcId.set(rpcKey(workerRpcId), {
      requestId: frame.requestId,
      originalRpcId: payload.id,
    });
    outbound = { ...payload, id: workerRpcId };
  }
  child.stdin.write(JSON.stringify(outbound) + '\n');
}

function handleControllerFrame(frame) {
  if (frame?.type === 'hello_ack') {
    connected = true;
    console.log('Connected to controller as ' + deviceId + '.');
    return;
  }
  if (frame?.type === 'ping') {
    writeFrame({ type: 'pong', at: Date.now() });
    return;
  }
  if (frame?.type === 'request' || frame?.type === 'notify') {
    sendToDesktopCommander(frame);
  }
}
function connectController() {
  if (stopping) return;
  connected = false;
  inputBuffer = '';
  socket = net.createConnection({ host: controllerHost, port: controllerPort });
  socket.setKeepAlive(true, 15000);
  socket.setNoDelay(true);
  socket.on('connect', () => {
    writeFrame({ type: 'hello', deviceId, name: deviceName, token: workerToken || undefined, version: '1' });
  });
  socket.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(inputBuffer, 'utf8') > 8 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      try { handleControllerFrame(JSON.parse(line)); }
      catch { socket.destroy(); return; }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (connected) console.log('Controller connection lost for ' + deviceId + '.');
    connected = false;
    pendingByRpcId.clear();
    socket = null;
    if (!stopping) setTimeout(connectController, reconnectMs);
  });
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  try { socket?.destroy(); } catch {}
  try { child?.kill(); } catch {}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  console.error('Worker fatal error:', error.message);
  process.exitCode = 1;
  shutdown();
});

startDesktopCommander();
connectController();
