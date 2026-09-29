import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fitWithin, opaqueBounds } from '../src/lib/labelImage.ts';

const dataPath = path.resolve(`.tmp-test-label-image-${process.pid}`);
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('logos shrink to fit the square keeping their shape, and small ones are never enlarged', () => {
  assert.deepEqual(fitWithin(4000, 1000, 256), { width: 256, height: 64 });
  assert.deepEqual(fitWithin(300, 900, 256), { width: 85, height: 256 });
  assert.deepEqual(fitWithin(32, 16, 256), { width: 32, height: 16 });
  assert.deepEqual(fitWithin(5000, 1, 256), { width: 256, height: 1 });
  assert.deepEqual(fitWithin(300, 150, 1024, true), { width: 1024, height: 512 });
});

test('transparent margins around a logo are found so they can be trimmed', () => {
  const width = 5;
  const height = 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const setAlpha = (x: number, y: number, alpha: number) => {
    pixels[(y * width + x) * 4 + 3] = alpha;
  };
  assert.equal(opaqueBounds(pixels, width, height), null);

  setAlpha(1, 1, 255);
  setAlpha(3, 2, 120);
  setAlpha(4, 3, 4); // antialiasing dust below the threshold stays margin
  assert.deepEqual(opaqueBounds(pixels, width, height), { x: 1, y: 1, width: 3, height: 2 });
});

test('uploaded logos are stored once per content and served back byte for byte', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    const upload = { mime: 'image/webp' as const, dataBase64: bytes.toString('base64') };

    const imageUrl = db.saveLabelImage(upload);
    assert.match(imageUrl, /^\/api\/label-images\/[0-9a-f]{32}$/);
    assert.equal(db.saveLabelImage(upload), imageUrl);

    const stored = db.getLabelImage(imageUrl.split('/').pop()!);
    assert.equal(stored?.mime, 'image/webp');
    assert.deepEqual(stored?.bytes, bytes);
    assert.equal(db.getLabelImage('missing'), null);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
