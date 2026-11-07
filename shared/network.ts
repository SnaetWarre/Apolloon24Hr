import { z } from 'zod';

const netAdapterProfileSchema = z.object({
  name: z.string(),
  address: z.string(),
  prefixLength: z.number().int().nullable(),
  dhcp: z.boolean().nullable(),
  connection: z.string().nullable(),
});

const elevationOutcomeSchema = z.object({
  id: z.string(),
  state: z.enum(['waiting', 'finished', 'failed']),
  message: z.string().nullable(),
  startedAt: z.number(),
});
export type ElevationOutcome = z.infer<typeof elevationOutcomeSchema>;

const elevateMethodSchema = z.enum(['uac', 'pkexec', 'osascript']).nullable();
export type ElevateMethod = z.infer<typeof elevateMethodSchema>;
export type NetAdapterProfile = z.infer<typeof netAdapterProfileSchema>;

export const netProfileSchema = z.object({
  platform: z.string(),
  windows: z.boolean(),
  elevateMethod: elevateMethodSchema,
  elevateHint: z.string().nullable(),
  manager: z.string().nullable(),
  adapters: z.array(netAdapterProfileSchema),
  primary: netAdapterProfileSchema.nullable(),
  apipa: z.boolean(),
  suggestion: z.object({ ip: z.string(), prefixLength: z.number().int(), gateway: z.string().nullable() }).nullable(),
  eventUrl: z.string().nullable(),
  primaryWired: z.boolean().nullable(),
  lastElevation: elevationOutcomeSchema.nullable(),
});
export type NetProfile = z.infer<typeof netProfileSchema>;

const networkFailureSchema = z.object({ ok: z.literal(false), error: z.string() });
export const netProfileResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), profile: netProfileSchema }),
  networkFailureSchema,
]);
export const netActionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), elevated: z.literal(true), elevationId: z.string().nullable() }),
  networkFailureSchema,
]);
export type NetActionResult = z.infer<typeof netActionResultSchema>;
