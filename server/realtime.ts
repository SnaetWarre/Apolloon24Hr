import type {
  AppSettings,
  Label,
  LapRecord,
  RaceEvent,
  RaceState,
  Runner,
  TemporaryTeam,
} from '../shared/schemas.js';

/** Socket.IO events the server emits; the event name is `type`. */
type RealtimeEvent =
  | { type: 'state:revision'; payload: number }
  | { type: 'runner:upserted'; payload: Runner }
  | { type: 'runners:upserted'; payload: Runner[] }
  | { type: 'runner:deleted'; payload: string }
  | { type: 'runners:patched'; payload: Runner[] }
  | { type: 'label:upserted'; payload: Label }
  | { type: 'label:deleted'; payload: string }
  | { type: 'labels:patched'; payload: Label[] }
  | { type: 'race:changed'; payload: RaceState }
  | { type: 'lap:created'; payload: LapRecord }
  | { type: 'lap:deleted'; payload: string }
  | { type: 'race-event:created'; payload: RaceEvent }
  | { type: 'settings:changed'; payload: AppSettings }
  | { type: 'temporary-teams:patched'; payload: TemporaryTeam[] };

let emitter: ((event: RealtimeEvent) => void) | null = null;

export function setRealtimeEmitter(nextEmitter: (event: RealtimeEvent) => void): void {
  emitter = nextEmitter;
}

export function emitRealtime(event: RealtimeEvent): void {
  emitter?.(event);
}
