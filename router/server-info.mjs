import fs from 'node:fs';

const packageUrl = new URL('../package.json', import.meta.url);
const packageInfo = JSON.parse(fs.readFileSync(packageUrl, 'utf8'));

export const serverInfo = Object.freeze({
  name: String(packageInfo.name),
  version: String(packageInfo.version),
});

export const routerClientInfo = Object.freeze({
  name: 'windows-console-router',
  version: serverInfo.version,
});
