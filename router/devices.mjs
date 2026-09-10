import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TAILSCALE_IPV4_RE = /^100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/u;

function optionalToken(value, deviceId, required) {
  const token = String(value || '');
  if (!required && !token) return '';
  if (token.length < 32 || token.length > 512) {
    throw new Error('Device ' + deviceId + ' token must be 32-512 characters.');
  }
  return token;
}

function requireTailscaleIp(value, deviceId) {
  const ip = String(value || '').trim();
  if (!TAILSCALE_IPV4_RE.test(ip)) throw new Error('Device ' + deviceId + ' requires a Tailscale IPv4 address.');
  return ip;
}

function normalizePathMappings(value, deviceId) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error('Device ' + deviceId + ' pathMappings must be an array.');
  const mappings = value.map((item) => {
    const from = String(item?.from || '').trim();
    const to = String(item?.to || '').trim();
    if (!/^[A-Za-z]:[\\/]*$/u.test(from)) {
      throw new Error('Device ' + deviceId + ' pathMappings.from must be a Windows drive root.');
    }
    if (!to.startsWith('/')) {
      throw new Error('Device ' + deviceId + ' pathMappings.to must be an absolute container path.');
    }
    return Object.freeze({
      from: from.slice(0, 1).toUpperCase() + ':\\',
      to: to === '/' ? '/' : to.replace(/\/+$/u, ''),
    });
  });
  return Object.freeze(mappings);
}

export function equalToken(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function loadDeviceRegistry(rootDir = process.cwd()) {
  const file = path.resolve(rootDir, 'config', 'devices.json');
  if (!fs.existsSync(file)) throw new Error('Device registry not found: ' + file);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Device registry is not valid JSON: ' + file); }
  if (!parsed || !Array.isArray(parsed.devices) || parsed.devices.length === 0) {
    throw new Error('Device registry must contain a non-empty devices array.');
  }
  const seen = new Set();
  const devices = parsed.devices.map((item) => {
    const deviceId = String(item?.deviceId || '').trim();
    if (!DEVICE_ID_RE.test(deviceId)) throw new Error('Invalid deviceId: ' + deviceId);
    if (seen.has(deviceId)) throw new Error('Duplicate deviceId: ' + deviceId);
    seen.add(deviceId);
    const local = item?.local === true;
    return Object.freeze({
      deviceId,
      name: String(item?.name || deviceId),
      enabled: item?.enabled !== false,
      local,
      token: optionalToken(item?.token, deviceId, local),
      tailscaleIp: local ? '' : requireTailscaleIp(item?.tailscaleIp, deviceId),
      pathMappings: normalizePathMappings(item?.pathMappings, deviceId),
      notes: String(item?.notes || ''),
    });
  });
  const enabled = devices.filter((device) => device.enabled);
  if (enabled.length === 0) throw new Error('At least one device must be enabled.');
  const defaultDeviceId = String(parsed.defaultDeviceId || enabled[0].deviceId);
  if (!enabled.some((device) => device.deviceId === defaultDeviceId)) {
    throw new Error('defaultDeviceId must reference an enabled device.');
  }
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  return Object.freeze({
    file,
    defaultDeviceId,
    devices: Object.freeze(devices),
    get(deviceId) {
      const device = byId.get(String(deviceId || '')) || null;
      return device?.enabled ? device : null;
    },
  });
}
