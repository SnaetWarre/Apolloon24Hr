import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
// Compiled to dist-server/server/, or run from server/ in development.
const compiledDistDir = path.resolve(serverDir, '..', '..', 'dist');
const DIST_DIR = fs.existsSync(compiledDistDir) ? compiledDistDir : path.resolve(serverDir, '..', 'dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const COMPRESSED_ASSET_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export function relativeFileWithinRoot(rootDir: string, filePath: string): string | null {
  const root = path.resolve(rootDir);
  const relativePath = path.relative(root, path.resolve(filePath));

  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath;
}

/** Serves the Vite build: precompressed hashed assets, then static files, then the SPA shell. */
export function registerStaticFrontend(app: Express): void {
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.path.startsWith('/assets/')) {
      next();
      return;
    }
    const originalPath = path.resolve(DIST_DIR, `.${req.path}`);
    if (!originalPath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
      next();
      return;
    }

    const encoding = req.acceptsEncodings('br', 'gzip');
    const extension = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : null;
    const compressedPath = extension ? `${originalPath}${extension}` : null;
    const relativePath = compressedPath && fs.existsSync(compressedPath)
      ? relativeFileWithinRoot(DIST_DIR, compressedPath)
      : null;
    if (!relativePath) {
      next();
      return;
    }

    const contentType = COMPRESSED_ASSET_CONTENT_TYPES.get(path.extname(originalPath));
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Encoding', encoding as string);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', IMMUTABLE_CACHE);
    res.sendFile(relativePath, { root: DIST_DIR });
  });

  app.use(
    express.static(DIST_DIR, {
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? IMMUTABLE_CACHE : 'no-cache');
      },
    })
  );

  app.get('/{*splat}', (_req, res) => {
    if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
      res.sendFile('index.html', { root: DIST_DIR });
      return;
    }
    res.status(404).send('Frontend build not found. Run vite in dev or npm run build first.');
  });
}
