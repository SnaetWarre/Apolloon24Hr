import { EventEmitter, on } from 'node:events';
import type { ClusterStatus } from '../shared/schemas.js';
import { clusterStatus } from './cluster.js';

/*
 * Screens get the group status pushed over their live connection when it
 * changes, instead of each asking for it every two seconds.
 */

const CHECK_MS = 1_000;
/** Free disk space moves with every log line on the laptop; smaller moves are not news. */
const DISK_STEP_BYTES = 64 * 1024 * 1024;

const feed = new EventEmitter<{ status: [ClusterStatus] }>();
feed.setMaxListeners(0);
let watchers = 0;
let timer: NodeJS.Timeout | null = null;
let lastFingerprint = '';

function fingerprint(status: ClusterStatus): string {
  const free = status.backup.diskFreeBytes;
  return JSON.stringify({
    ...status,
    backup: { ...status.backup, diskFreeBytes: free === null ? null : Math.round(free / DISK_STEP_BYTES) },
  });
}

function check(): void {
  const status = clusterStatus();
  const next = fingerprint(status);
  if (next === lastFingerprint) return;
  lastFingerprint = next;
  feed.emit('status', status);
}

/** The status now, then every change; checked once a second for all screens together, only while one listens. */
export async function* clusterStatusUpdates(signal: AbortSignal | undefined): AsyncGenerator<ClusterStatus> {
  watchers += 1;
  if (!timer) {
    lastFingerprint = '';
    timer = setInterval(check, CHECK_MS);
    timer.unref();
  }
  try {
    const changes = on(feed, 'status', { signal });
    yield clusterStatus();
    for await (const [status] of changes) yield status as ClusterStatus;
  } finally {
    watchers -= 1;
    if (watchers === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}
