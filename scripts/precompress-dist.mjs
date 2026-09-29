#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const assetsDir = path.resolve('dist', 'assets');
const compressibleExtensions = new Set(['.css', '.js', '.json', '.svg']);
const minimumBytes = 1_024;

let entries;
try {
  entries = await fs.readdir(assetsDir, { withFileTypes: true });
} catch (error) {
  throw new Error(`Cannot precompress Vite assets in ${assetsDir}`, { cause: error });
}

const files = entries
  .filter((entry) => entry.isFile() && compressibleExtensions.has(path.extname(entry.name)))
  .map((entry) => path.join(assetsDir, entry.name));

let compressedCount = 0;
let sourceBytes = 0;
let brotliBytes = 0;

await Promise.all(
  files.map(async (filePath) => {
    const source = await fs.readFile(filePath);
    if (source.byteLength < minimumBytes) return;

    const [brotli, gzipped] = await Promise.all([
      compressBrotli(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 8,
        },
      }),
      compressGzip(source, { level: 9 }),
    ]);

    await Promise.all([fs.writeFile(`${filePath}.br`, brotli), fs.writeFile(`${filePath}.gz`, gzipped)]);
    compressedCount += 1;
    sourceBytes += source.byteLength;
    brotliBytes += brotli.byteLength;
  })
);

const percent = sourceBytes > 0 ? Math.round((brotliBytes / sourceBytes) * 100) : 0;
console.log(`Precompressed ${compressedCount} assets: Brotli is ${percent}% of source size.`);
