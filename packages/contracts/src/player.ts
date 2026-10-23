import { z } from 'zod';
import { ATTRIBUTE_KEYS, RealmSchema } from './enums.js';
import { LIMITS } from './limits.js';

const attr = z.number().int().min(LIMITS.attribute.min).max(LIMITS.attribute.max);

export const AttributesSchema = z
  .object(Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, attr])) as Record<(typeof ATTRIBUTE_KEYS)[number], typeof attr>)
  .strict();
export type Attributes = z.infer<typeof AttributesSchema>;

export const PlayerStateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(32),
    level: z.number().int().min(LIMITS.level.min).max(LIMITS.level.max),
    realm: RealmSchema,
    hp: z.number().int().min(0).max(LIMITS.hpMax),
    maxHp: z.number().int().min(1).max(LIMITS.hpMax),
    stamina: z.number().int().min(0).max(LIMITS.staminaMax),
    maxStamina: z.number().int().min(1).max(LIMITS.staminaMax),
    silver: z.number().int().min(0).max(LIMITS.silverMax),
    attributes: AttributesSchema,
    version: z.number().int().min(0),
  })
  .strict()
  .refine((s) => s.hp <= s.maxHp, { message: 'hp 不得超过 maxHp', path: ['hp'] })
  .refine((s) => s.stamina <= s.maxStamina, { message: 'stamina 不得超过 maxStamina', path: ['stamina'] });
export type PlayerState = z.infer<typeof PlayerStateSchema>;
