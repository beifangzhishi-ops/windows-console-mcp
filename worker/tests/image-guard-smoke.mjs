import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dcRoot = path.join(workerRoot, 'node_modules', '@wonderwhy-er', 'desktop-commander');
const dcPackage = path.join(dcRoot, 'package.json');
const requireFromDc = createRequire(dcPackage);
const sharp = requireFromDc('sharp');
const factoryUrl = pathToFileURL(path.join(dcRoot, 'dist', 'utils', 'files', 'factory.js')).href;
const { getFileHandler } = await import(factoryUrl + '?smoke=' + Date.now());

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wcm-image-guard-'));
try {
  const corruptJpeg = path.join(temp, 'corrupt.jpg');
  const smallPng = path.join(temp, 'small.png');
  const largeJpeg = path.join(temp, 'large.jpg');

  await fs.writeFile(corruptJpeg, Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
  ]));
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
    .png().toFile(smallPng);
  const width = 1200;
  const height = 1200;
  const randomPixels = crypto.randomBytes(width * height * 3);
  await sharp(randomPixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 }).toFile(largeJpeg);

  const corruptHandler = await getFileHandler(corruptJpeg);
  assert.equal(corruptHandler.constructor.name, 'BinaryFileHandler');
  const corruptResult = await corruptHandler.read(corruptJpeg);
  assert.equal(corruptResult.metadata?.isBinary, true);

  const smallHandler = await getFileHandler(smallPng);
  assert.equal(smallHandler.constructor.name, 'ImageFileHandler');
  const smallResult = await smallHandler.read(smallPng);
  assert.equal(smallResult.metadata?.isImage, true);
  assert.equal(smallResult.metadata?.preview, undefined);

  const largeHandler = await getFileHandler(largeJpeg);
  assert.equal(largeHandler.constructor.name, 'ImageFileHandler');
  const largeResult = await largeHandler.read(largeJpeg);
  if (largeResult.metadata?.preview) {
    assert.ok(largeResult.metadata.previewSize <= 131072);
    assert.equal(largeResult.mimeType, 'image/webp');
  } else {
    assert.equal(largeResult.metadata?.imageTooLarge, true);
    assert.equal(largeResult.mimeType, 'text/plain');
  }

  console.log('image guard smoke: ok');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}