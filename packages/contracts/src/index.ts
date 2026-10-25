import { z } from 'zod';

export * from './enums.js';
export * from './limits.js';
export * from './npc.js';
export * from './player.js';
export * from './quest.js';
export * from './action.js';
export * from './ai-plan.js';
export * from './ai-status.js';
export * from './inventory.js';
export * from './cultivation.js';
export * from './location.js';
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
