import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_HOST = '127.0.0.1';
export const SIDECAR_PORT = 18008;
export const UPSTREAM_URL = 'http://127.0.0.1:18009';
export const FORBIDDEN_PORTS = new Set([8317, 8765, 8766, 8767, 12306, 18007, 18009]);

function unquoteEnvValue(value) {
  if (value.length < 2) {
    return value;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function resolveFromRoot(rootDir, value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function requireInteger(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
  }
  return parsed;
}

function requireBoolean(name, value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  throw new Error(name + ' must be a boolean value.');
}

function normalizeUpstreamUrl(value) {
  let upstream;
  try {
    upstream = new URL(value);
  } catch {
    throw new Error('RDC_UPSTREAM_URL must be a valid URL.');
  }
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    upstream.port !== '18009' ||
    (upstream.pathname !== '/' && upstream.pathname !== '')
  ) {
    throw new Error('RDC_UPSTREAM_URL must remain http://127.0.0.1:18009.');
  }
  return UPSTREAM_URL;
}

function requireHttpsIdentity(name, value, expectedPath) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(name + ' is required.');
  let url;
  try { url = new URL(text); }
  catch { throw new Error(name + ' must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(name + ' must be a clean HTTPS URL without credentials, query, or fragment.');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  if (pathname !== expectedPath) throw new Error(name + ' path must be ' + expectedPath + '.');
  return url.origin + expectedPath;
}

function wellKnownUrl(identity, kind) {
  const url = new URL(identity);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  return `${url.origin}/.well-known/${kind}${pathname}`;
}

export function createConfig(options = {}) {
  const {
    rootDir = process.cwd(),
    envPath = path.join(rootDir, 'config', 'rdc.env'),
    envValues = {},
    readEnvFile = true,
    host,
    port,
    upstreamUrl,
    issuer,
    resource,
    stateFile,
    upstreamSessionFile,
    workspaceMode,
    workspaceStateFile,
    approvalSecretFile,
    logDir,
    tokenTtlSeconds,
    approvalSecret,
    allowEphemeral = false,
  } = options;

  let fileValues = {};
  if (readEnvFile) {
    if (!fs.existsSync(envPath)) {
      throw new Error('RDC config file was not found: ' + envPath);
    }
    fileValues = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  }
  const values = { ...fileValues, ...envValues };
  const selectedHost = host ?? values.RDC_SIDECAR_HOST ?? SIDECAR_HOST;
  if (selectedHost !== SIDECAR_HOST) {
    throw new Error('RDC_SIDECAR_HOST must be ' + SIDECAR_HOST + '.');
  }

  const selectedPort = requireInteger(
    'RDC_SIDECAR_PORT',
    port ?? values.RDC_SIDECAR_PORT ?? SIDECAR_PORT,
    allowEphemeral ? 0 : 1,
    65535,
  );
  if (selectedPort !== 0 && FORBIDDEN_PORTS.has(selectedPort)) {
    throw new Error('RDC_SIDECAR_PORT cannot use a reserved port: ' + selectedPort + '.');
  }

  const selectedIssuer = requireHttpsIdentity(
    'RDC_ISSUER',
    issuer ?? values.RDC_ISSUER,
    '/rdc',
  );
  const selectedResource = requireHttpsIdentity(
    'RDC_RESOURCE',
    resource ?? values.RDC_RESOURCE,
    '/rdc/mcp',
  );
  if (new URL(selectedIssuer).origin !== new URL(selectedResource).origin) {
    throw new Error('RDC_ISSUER and RDC_RESOURCE must use the same HTTPS origin.');
  }
  const selectedUpstreamUrl = normalizeUpstreamUrl(
    upstreamUrl ?? values.RDC_UPSTREAM_URL ?? UPSTREAM_URL,
  );
  const selectedTtl = requireInteger(
    'RDC_TOKEN_TTL_SECONDS',
    tokenTtlSeconds ?? values.RDC_TOKEN_TTL_SECONDS ?? 3600,
    60,
    86400,
  );

  const selectedWorkspaceMode = requireBoolean(
    'RDC_WORKSPACE_MODE',
    workspaceMode ?? values.RDC_WORKSPACE_MODE ?? false,
  );
  if (selectedWorkspaceMode) {
    throw new Error('RDC_WORKSPACE_MODE must remain disabled.');
  }

  const selectedStateFile = resolveFromRoot(
    rootDir,
    stateFile ?? values.RDC_STATE_FILE ?? '.state/rdc-oauth-state.json',
  );
  const selectedUpstreamSessionFile = resolveFromRoot(
    rootDir,
    upstreamSessionFile ??
      values.RDC_UPSTREAM_SESSION_FILE ??
      '.state/rdc-upstream-session.json',
  );
  const selectedWorkspaceStateFile = resolveFromRoot(
    rootDir,
    workspaceStateFile ?? values.RDC_WORKSPACE_STATE_FILE ?? '.state/rdc-workspace.json',
  );
  const selectedApprovalSecretFile = resolveFromRoot(
    rootDir,
    approvalSecretFile ??
      values.RDC_APPROVAL_SECRET_FILE ??
      '.state/rdc-approval-secret.txt',
  );
  const selectedLogDir = resolveFromRoot(rootDir, logDir ?? values.RDC_LOG_DIR ?? 'logs');

  return Object.freeze({
    rootDir,
    host: selectedHost,
    port: selectedPort,
    upstreamUrl: selectedUpstreamUrl,
    issuer: selectedIssuer,
    resource: selectedResource,
    protectedResourceMetadataUrl: wellKnownUrl(selectedResource, 'oauth-protected-resource'),
    authorizationServerMetadataUrl: wellKnownUrl(selectedIssuer, 'oauth-authorization-server'),
    stateFile: selectedStateFile,
    upstreamSessionFile: selectedUpstreamSessionFile,
    workspaceMode: selectedWorkspaceMode,
    workspaceStateFile: selectedWorkspaceStateFile,
    approvalSecretFile: selectedApprovalSecretFile,
    logDir: selectedLogDir,
    tokenTtlSeconds: selectedTtl,
    approvalSecret,
  });
}

export function loadConfig(rootDir = process.cwd()) {
  return createConfig({ rootDir });
}
