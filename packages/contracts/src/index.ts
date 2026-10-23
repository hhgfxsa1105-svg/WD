import { z } from 'zod';

export * from './enums.js';
export * from './limits.js';
export * from './player.js';
export * from './action.js';
export * from './ai-plan.js';
export * from './inventory.js';
export * from './cultivation.js';
export * from './log.js';
export * from './audit.js';
export * from './world.js';
export * from './error.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
