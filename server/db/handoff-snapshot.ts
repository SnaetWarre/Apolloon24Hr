import { z } from 'zod';
import { raceStateSchema, runnerStatusSchema } from '../../shared/schemas.js';

export const queueStateSchema = z.object({
  runnerId: z.string(),
  status: runnerStatusSchema,
  queueIndex: z.number().int().nullable().default(null),
  statusSince: z.number().nullable().default(null),
  hiddenAt: z.number().nullable().default(null),
});
export type QueueState = z.infer<typeof queueStateSchema>;

/** Older undo entries omit kind and some race fields; present fields must still be valid. */
export const handoffSnapshotSchema = z.object({
  kind: z.enum(['handoff', 'finish']).optional(),
  raceState: raceStateSchema.partial(),
  queueEntries: z.array(queueStateSchema).default([]),
  lapIds: z.array(z.string()).default([]),
});
export type HandoffSnapshot = z.infer<typeof handoffSnapshotSchema>;
