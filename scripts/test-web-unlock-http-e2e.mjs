// Fully isolated real-HTTP sidecar -> Router -> mocked one-time TOTP ->
// time-limited grant -> model claim. Never touches production credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createConfig } from '../rdc-sidecar/config.mjs';
import { createRdcServer, listenRdcServer, closeRdcServer } from '../rdc-sidecar/server.mjs';
import { WebUnlockManager } from '../router/web-unlock.mjs';
import { TimedGrantManager } from '../router/timed-grant-manager.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-web-http-e2e-'));
let mockOtpUsed = false;
const grants = new TimedGrantManager();
const manager = new WebUnlockManager({
  stateFile: path.join(root, 'paired-browser-hashes.json'),
  policy: () => ({ mode: 'both', revision: 10 }),
  grants,
  verifyCode: (code) => {
    if (code !== '654321' || mockOtpUsed) return false;
    mockOtpUsed = true;
    return true;
  },
});

async function readBody(request, maxBytes) {
  let size = 0;
  const buffers = [];
  for await (const buffer of request) {
    size += buffer.length;
    if (size > maxBytes) throw new Error('Test request too large');
    buffers.push(buffer);
  }
  return Buffer.concat(buffers).toString('utf8');
}

const router = http.createServer((req, res) => {
  manager.handleHttp(req, res, readBody).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const config = createConfig({
  rootDir: root, readEnvFile: false, allowEphemeral: true, port: 0,
  issuer: 'https://mock-wcm.test/rdc',
  resource: 'https://mock-wcm.test/rdc/mcp',
  approvalSecret: 'mock-only-not-production-approval-key',
});
let sidecar;

const cookies = new Map();
function absorbCookies(response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(';', 1);
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
const csrfFromHtml = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

async function withServer(base, fields, { origin, referer, fetchSite, forwardCookies = true } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (origin !== undefined) headers.Origin = origin;
  if (referer !== undefined) headers.Referer = referer;
  if (fetchSite !== undefined) headers['Sec-Fetch-Site'] = fetchSite;
  if (forwardCookies) headers.Cookie = cookieHeader();
  const response = await fetch(base, {
    method: 'POST', headers, body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  absorbCookies(response);
  return { response, text: await response.text() };
}

try {
  await new Promise((resolve, reject) => {
    router.once('error', reject);
    router.listen(0, '127.0.0.1', resolve);
  });
  const routerPort = router.address().port;
  sidecar = createRdcServer({
    config,
    webUnlockUpstreamUrl: `http://127.0.0.1:${routerPort}`,
    logger: { log() {}, error() {} },
  });
  await listenRdcServer(sidecar, 0, '127.0.0.1');
  const pageUrl = `http://127.0.0.1:${sidecar.server.address().port}/rdc/unlock`;

  let response = await fetch(pageUrl, { redirect: 'manual' });
  assert.equal(response.status, 200);
  absorbCookies(response);
  let html = await response.text();
  assert.match(html, /WCM 临时解锁/);
  const csrf = csrfFromHtml(html);
  assert.ok(csrf);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  // Even with a valid form token, missing cookies may not pair.
  let attempt = await withServer(pageUrl, { action: 'pair', csrf, code: '654321' }, {
    origin: 'null', forwardCookies: false,
  });
  assert.equal(attempt.response.status, 403);
  assert.match(attempt.text, /表单已过期/);
  assert.equal(mockOtpUsed, false);

  // Reproduce the mobile symptom: explicitly opaque/foreign Origin, Referer
  // and Fetch Metadata, yet valid owner form + matching CSRF cookie.
  attempt = await withServer(pageUrl, { action: 'pair', csrf, code: '654321' }, {
    origin: 'null', referer: 'https://embedded-browser.invalid/page', fetchSite: 'cross-site',
  });
  assert.equal(attempt.response.status, 303);
  assert.equal(attempt.response.headers.get('location'), '/rdc/unlock?paired=1');
  assert.equal(mockOtpUsed, true);
  assert.equal(grants.snapshot().grant_count, 0, 'pairing alone must not unlock');
  assert.ok(cookieHeader().includes('__Secure-wcm-web-pair='));

  response = await fetch(pageUrl + '?paired=1', {
    headers: { Cookie: cookieHeader() }, redirect: 'manual',
  });
  assert.equal(response.status, 200);
  absorbCookies(response);
  html = await response.text();
  assert.match(html, /临时解锁 WCM/);
  assert.doesNotMatch(html, /name="code"/);

  attempt = await withServer(pageUrl, {
    csrf: csrfFromHtml(html), action: 'unlock', duration_seconds: '300',
  }, { origin: 'https://mobile-in-app-webview.invalid', referer: 'null', fetchSite: 'cross-site' });
  assert.equal(attempt.response.status, 303);
  assert.equal(attempt.response.headers.get('location'), '/rdc/unlock?issued=1');
  assert.equal(grants.snapshot().grant_count, 1);
  const claimed = manager.claim();
  assert.equal(claimed?.grant_state, 'active');
  assert.equal(claimed?.requested_duration_seconds, 300);
  assert.equal(manager.claim(), null, 'no re-claim');
  assert.equal(grants.active(claimed.approval_id)?.grant_state, 'active');

  // Forged form with attacker-controlled origin but no paired-browser cookie
  // or CSRF secret must never issue a new grant.
  attempt = await withServer(pageUrl, {
    csrf: csrfFromHtml(html), action: 'unlock', duration_seconds: '21600',
  }, { origin: 'https://attacker.invalid', forwardCookies: false });
  assert.equal(attempt.response.status, 403);
  assert.equal(grants.snapshot().grant_count, 1);
  console.log('WCM isolated real-HTTP web E2E: mock OTP pair -> mobile POST -> timed grant -> claim-once PASS');
  console.log('WCM invalid/missing cookies -> fail-closed PASS');
} finally {
  if (sidecar) await closeRdcServer(sidecar);
  await new Promise((resolve) => router.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
