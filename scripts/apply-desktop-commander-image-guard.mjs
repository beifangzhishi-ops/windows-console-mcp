import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
process.env.DESKTOP_COMMANDER_ROOT = path.join(
  repoRoot,
  'node_modules',
  '@wonderwhy-er',
  'desktop-commander'
);

const patch = path.join(repoRoot, 'worker', 'patches', 'desktop-commander-image-guard.mjs');
await import(pathToFileURL(patch).href);