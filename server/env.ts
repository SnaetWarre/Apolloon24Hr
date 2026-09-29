import path from 'node:path';

export const DATA_ROOT = path.resolve(process.env.DATA_PATH || process.cwd());

export const RELEASE_ID = process.env.APOLLOON_RELEASE_ID?.trim() || null;

/** Set by Electron from package.json, and by npm scripts during development. */
export const APP_VERSION =
  process.env.APOLLOON_APP_VERSION?.trim() || process.env.npm_package_version?.trim() || '0.0.0-dev';

/** Linking laptops into one group; on in the packaged app, opt-in elsewhere. */
export function isClusterEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CLUSTER_ENABLED === 'true';
}

export function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}
