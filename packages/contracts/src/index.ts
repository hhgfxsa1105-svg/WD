import { z } from 'zod';

export * from './enums.js';
export * from './limits.js';
export * from './player.js';
export * from './action.js';
export * from './error.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
