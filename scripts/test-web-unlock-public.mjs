// Production-safe HTTPS web form acceptance: never submit a TOTP or create a
// grant. Proves the public Funnel forwards browser-origin POSTs to CSRF and
// paired-browser validation, not a proxy or Origin-header rejector.
import assert from 'node:assert/strict';
import { loadConfig } from '../rdc-sidecar/config.mjs';

const endpoint = new URL(loadConfig(process.cwd()).issuer);
endpoint.pathname = '/rdc/unlock';
const url = endpoint.toString();
const get = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
assert.equal(get.status, 200, 'Public HTTPS form GET');
const page = await get.text();
assert.match(page, /WCM 临时解锁/);
const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie = get.headers.getSetCookie()
  .find((header) => header.startsWith('__Secure-wcm-web-csrf='))
  ?.split(';', 1)[0];
assert.ok(csrf && cookie, 'Public page must provide CSRF cookie and form token');
const body = new URLSearchParams({
  csrf, action: 'unlock', duration_seconds: '300',
}).toString();

const mobile = await fetch(url, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
  headers: {
    Cookie: cookie,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'null',
    Referer: 'https://embedded-webview.invalid/',
    'Sec-Fetch-Site': 'cross-site',
  },
  body,
});
assert.equal(mobile.status, 403, 'Unpaired browser must still fail closed');
const mobileText = await mobile.text();
assert.match(mobileText, /请先配对浏览器/);
console.log('Public HTTPS GET + Android-style POST with valid CSRF: reached pairing gate PASS');

const forged = await fetch(url, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://untrusted.invalid',
  },
  body,
});
assert.equal(forged.status, 403, 'Missing CSRF cookie must fail closed');
const forgedText = await forged.text();
assert.match(forgedText, /表单已过期/);
console.log('Public HTTPS POST without CSRF cookie: denied PASS');
