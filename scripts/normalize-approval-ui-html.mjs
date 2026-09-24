import fs from 'node:fs';
import path from 'node:path';

const bundlePath = path.resolve('ui', 'dist', 'approval-test.html');
const html = fs.readFileSync(bundlePath, 'utf8');
const moduleScriptPattern = /<script\s+type="module"\s+crossorigin>([\s\S]*?)<\/script>\s*/u;
const matches = [...html.matchAll(new RegExp(moduleScriptPattern.source, 'gu'))];

if (matches.length !== 1) {
  throw new Error(`Expected exactly one inline Vite module script, found ${matches.length}.`);
}
if (!html.includes('</body>')) {
  throw new Error('Approval UI bundle is missing </body>.');
}

const scriptSource = matches[0][1];
if (/\b(?:import|export)\s/u.test(scriptSource)) {
  throw new Error('Approval UI bundle still contains module-only import/export syntax.');
}

// Validate that the generated code is legal as a classic script before rewriting it.
new Function(scriptSource);

const withoutModuleScript = html.replace(moduleScriptPattern, '');
const normalized = withoutModuleScript.replace(
  '</body>',
  `  <script>${scriptSource}</script>\n</body>`,
);

fs.writeFileSync(bundlePath, normalized, 'utf8');
console.log('WCM approval UI classic-script normalization: PASS');
