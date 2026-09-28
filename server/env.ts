import path from 'node:path';

export const DATA_ROOT = path.resolve(process.env.DATA_PATH || process.cwd());

export const RELEASE_ID = process.env.APOLLOON_RELEASE_ID?.trim() || null;

export function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}
