import type {
  AppSettings,
  AppSnapshot,
  Label,
  LapRecord,
  RaceEvent,
  RaceState,
  Runner,
  TemporaryTeam,
} from '../shared/schemas.js';

export type RealtimeEvent =
  | { type: 'bootstrap'; payload: AppSnapshot }
  | { type: 'runner:upserted'; payload: Runner }
  | { type: 'runner:deleted'; payload: string }
  | { type: 'runners:patched'; payload: Runner[] }
  | { type: 'label:upserted'; payload: Label }
  | { type: 'label:deleted'; payload: string }
  | { type: 'labels:patched'; payload: Label[] }
  | { type: 'queue:patched'; payload: Runner[] }
  | { type: 'race:changed'; payload: RaceState }
  | { type: 'lap:created'; payload: LapRecord }
  | { type: 'lap:deleted'; payload: string }
  | { type: 'laps:patched'; payload: LapRecord[] }
  | { type: 'race-event:created'; payload: RaceEvent }
  | { type: 'race-events:patched'; payload: RaceEvent[] }
  | { type: 'settings:changed'; payload: AppSettings }
  | { type: 'temporary-teams:patched'; payload: TemporaryTeam[] };

let emitter: ((event: RealtimeEvent) => void) | null = null;

export function setRealtimeEmitter(nextEmitter: (event: RealtimeEvent) => void): void {
  emitter = nextEmitter;
}

export function emitRealtime(event: RealtimeEvent): void {
  emitter?.(event);
}
