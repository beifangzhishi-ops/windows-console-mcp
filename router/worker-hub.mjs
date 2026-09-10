import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { equalToken } from './devices.mjs';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const HELLO_TIMEOUT_MS = 10000;

function encodeFrame(value) {
  return JSON.stringify(value) + '\n';
}

function safeDestroy(socket) {
  try { socket.destroy(); } catch {}
}

function normalizeIp(value) {
  const text = String(value || '');
  return text.startsWith('::ffff:') ? text.slice(7) : text;
}

function traceValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return String(text).replace(/\s+/gu, ' ').slice(0, 160);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

export class WorkerHub {
  constructor({
    registry,
    host = '127.0.0.1',
    port = 18101,
    remoteHost = '',
    remotePort = 18100,
    logger = console,
  } = {}) {
    this.registry = registry;
    this.host = host;
    this.port = port;
    this.remoteHost = remoteHost;
    this.remotePort = remotePort;
    this.logger = logger;
    this.localServer = null;
    this.remoteServer = null;
    this.connections = new Map();
    this.pending = new Map();
  }

  async start() {
    if (this.localServer) return;
    this.localServer = net.createServer((socket) => this.#accept(socket, 'local'));
    this.localServer.on('error', (error) => this.logger.error('Local worker hub error:', error.message));
    await listen(this.localServer, this.port, this.host);
    if (this.remoteHost) {
      this.remoteServer = net.createServer((socket) => this.#accept(socket, 'tailscale'));
      this.remoteServer.on('error', (error) => this.logger.error('Remote worker hub error:', error.message));
      try {
        await listen(this.remoteServer, this.remotePort, this.remoteHost);
      } catch (error) {
        await closeServer(this.localServer);
        this.localServer = null;
        throw error;
      }
    }
  }

  #accept(socket, transport) {
    socket.setKeepAlive(true, 15000);
    socket.setNoDelay(true);
    const state = {
      socket,
      transport,
      sourceIp: normalizeIp(socket.remoteAddress),
      buffer: '',
      authenticated: false,
      deviceId: null,
      connectionId: randomUUID(),
    };
    const helloTimer = setTimeout(() => safeDestroy(socket), HELLO_TIMEOUT_MS);
    socket.on('data', (chunk) => this.#onData(state, chunk, helloTimer));
    socket.on('error', () => {});
    socket.on('close', () => this.#onClose(state));
  }
  #onData(state, chunk, helloTimer) {
    state.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_FRAME_BYTES) {
      safeDestroy(state.socket);
      return;
    }
    let newline;
    while ((newline = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch { safeDestroy(state.socket); return; }
      if (!state.authenticated) {
        if (!this.#authenticate(state, frame)) {
          safeDestroy(state.socket);
          return;
        }
        clearTimeout(helloTimer);
        continue;
      }
      this.#handleFrame(state, frame);
    }
  }

  #authenticate(state, frame) {
    if (frame?.type !== 'hello') return false;
    const device = this.registry.get(frame.deviceId);
    if (!device) return false;
    if (device.local) {
      if (state.transport !== 'local' || !equalToken(frame.token, device.token)) return false;
    } else {
      if (state.transport !== 'tailscale') return false;
      if (!device.tailscaleIp || state.sourceIp !== device.tailscaleIp) return false;
    }

    const existing = this.connections.get(device.deviceId);
    if (existing && existing.socket !== state.socket) safeDestroy(existing.socket);
    state.authenticated = true;
    state.deviceId = device.deviceId;
    state.name = String(frame.name || device.name);
    state.connectedAt = Date.now();
    state.lastSeen = Date.now();
    this.connections.set(device.deviceId, state);
    state.socket.write(encodeFrame({
      type: 'hello_ack',
      deviceId: device.deviceId,
      connectionId: state.connectionId,
      heartbeatMs: 15000,
    }));
    this.logger.log('Worker connected: ' + device.deviceId + ' via ' + state.transport);
    return true;
  }

  #handleFrame(state, frame) {
    state.lastSeen = Date.now();
    if (frame?.type === 'pong') return;
    if (frame?.type !== 'response' || typeof frame.requestId !== 'string') return;
    const pending = this.pending.get(frame.requestId);
    if (!pending || pending.deviceId !== state.deviceId) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.requestId);
    this.logger.log(`CALL END requestId=${frame.requestId} device=${state.deviceId} method=${pending.method} rpcId=${pending.rpcId} elapsedMs=${Date.now() - pending.startedAt} result=${frame.error ? 'error' : 'ok'}`);
    if (frame.error) pending.reject(new Error(String(frame.error)));
    else pending.resolve(frame.message);
  }

  #onClose(state) {
    if (state.authenticated && this.connections.get(state.deviceId) === state) {
      this.connections.delete(state.deviceId);
      this.logger.log('Worker disconnected: ' + state.deviceId);
      for (const [requestId, pending] of this.pending) {
        if (pending.deviceId !== state.deviceId) continue;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new Error('Worker disconnected: ' + state.deviceId));
      }
    }
  }

  connectionInfo(deviceId) {
    const state = this.connections.get(deviceId);
    if (!state) return null;
    return {
      deviceId,
      connectionId: state.connectionId,
      connectedAt: state.connectedAt,
      lastSeen: state.lastSeen,
      name: state.name,
      transport: state.transport,
      sourceIp: state.sourceIp,
    };
  }
  listStatus() {
    return this.registry.devices.filter((device) => device.enabled).map((device) => {
      const info = this.connectionInfo(device.deviceId);
      return {
        deviceId: device.deviceId,
        name: device.name,
        online: Boolean(info),
        local: device.local,
        notes: device.notes || undefined,
        connectedAt: info?.connectedAt || undefined,
        transport: info?.transport || undefined,
        sourceIp: info?.sourceIp || undefined,
      };
    });
  }

  call(deviceId, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    const state = this.connections.get(deviceId);
    if (!state) return Promise.reject(new Error('Worker is offline: ' + deviceId));
    const requestId = randomUUID();
    const startedAt = Date.now();
    const method = traceValue(payload?.method);
    const rpcId = traceValue(payload?.id);
    this.logger.log(`CALL BEGIN requestId=${requestId} device=${deviceId} method=${method} rpcId=${rpcId} timeoutMs=${timeoutMs}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.logger.error(`CALL TIMEOUT requestId=${requestId} device=${deviceId} method=${method} rpcId=${rpcId} elapsedMs=${Date.now() - startedAt}`);
        reject(new Error('Worker request timed out: ' + deviceId));
      }, timeoutMs);
      this.pending.set(requestId, { deviceId, resolve, reject, timer, startedAt, method, rpcId });
      try {
        state.socket.write(encodeFrame({ type: 'request', requestId, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.logger.error(`CALL WRITE_ERROR requestId=${requestId} device=${deviceId} method=${method} rpcId=${rpcId} message=${traceValue(error?.message || error)}`);
        reject(error);
      }
    });
  }
  notify(deviceId, payload) {
    const state = this.connections.get(deviceId);
    if (!state) return false;
    try {
      state.socket.write(encodeFrame({ type: 'notify', payload }));
      return true;
    } catch {
      return false;
    }
  }

  pingAll() {
    for (const state of this.connections.values()) {
      try { state.socket.write(encodeFrame({ type: 'ping', at: Date.now() })); }
      catch { safeDestroy(state.socket); }
    }
  }

  async stop() {
    for (const state of this.connections.values()) safeDestroy(state.socket);
    this.connections.clear();
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker hub stopped.'));
      this.pending.delete(requestId);
    }
    const localServer = this.localServer;
    const remoteServer = this.remoteServer;
    this.localServer = null;
    this.remoteServer = null;
    await Promise.all([closeServer(localServer), closeServer(remoteServer)]);
  }
}
