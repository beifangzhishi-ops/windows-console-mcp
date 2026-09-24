import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(moduleDir, '..', 'ui', 'dist', 'approval-test.html');

if (!fs.existsSync(bundlePath)) {
  throw new Error('Missing MCP App bundle. Run `npm run build:ui` before starting WCM.');
}

export const APPROVAL_TEST_UI_HTML = fs.readFileSync(bundlePath, 'utf8');
const bundleHash = createHash('sha256').update(APPROVAL_TEST_UI_HTML).digest('hex').slice(0, 16);
export const APPROVAL_TEST_UI_URI = `ui://wcm/approval-test/${bundleHash}.html`;
