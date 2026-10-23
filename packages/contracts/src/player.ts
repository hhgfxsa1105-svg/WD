import { z } from 'zod';
import { ATTRIBUTE_KEYS, EffectKindSchema, GradeSchema, REALMS, RealmSchema, type Realm } from './enums.js';
import { LIMITS } from './limits.js';

/** 内力自「后天」起有效；炼体、通窍没有内力 */
const NEILI_MIN_REALM_INDEX = REALMS.indexOf('houtian');
export const realmHasNeili = (realm: Realm): boolean => REALMS.indexOf(realm) >= NEILI_MIN_REALM_INDEX;

const attr = z.number().int().min(LIMITS.attribute.min).max(LIMITS.attribute.max);
export const AttributesSchema = z
  .object(Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, attr])) as Record<(typeof ATTRIBUTE_KEYS)[number], typeof attr>)
  .strict();
export type Attributes = z.infer<typeof AttributesSchema>;

const money = z.number().int().min(0).max(LIMITS.currencyMax);
/** 三种货币：元宝、银两、铜钱 */
export const CurrencySchema = z.object({ yuanbao: money, silver: money, copper: money }).strict();
export type Currency = z.infer<typeof CurrencySchema>;

/** value 的单位随 kind：exp_multiplier / chance_modifier 为百分点，affinity_modifier / attribute_bonus 为整数加值 */
export const EffectSchema = z
  .object({ kind: EffectKindSchema, value: z.number().int().min(-1000).max(1000), text: z.string().min(1).max(60) })
  .strict();
export type Effect = z.infer<typeof EffectSchema>;

/** 名号（头衔 / 称号 / 命格）：均有评级与效果；效果由规则表定义并由程序结算 */
export const HonorificSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(16),
    grade: GradeSchema,
    effects: z.array(EffectSchema).max(8),
  })
  .strict();
export type Honorific = z.infer<typeof HonorificSchema>;

export const NeiliSchema = z
  .object({
    current: z.number().int().min(0).max(LIMITS.neiliMax),
    max: z.number().int().min(1).max(LIMITS.neiliMax),
  })
  .strict()
  .refine((n) => n.current <= n.max, { message: 'neili.current 不得超过 max', path: ['current'] });

export const LocationRefSchema = z
  .object({ id: z.string().min(1).max(64), name: z.string().min(1).max(32) })
  .strict();
export type LocationRef = z.infer<typeof LocationRefSchema>;

export const PlayerStateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(32),
    realm: RealmSchema,
    /** 晋级进度百分比；经验由功法评级决定 */
    realmProgress: z.number().int().min(LIMITS.progress.min).max(LIMITS.progress.max),
    hp: z.number().int().min(0).max(LIMITS.hpMax),
    maxHp: z.number().int().min(1).max(LIMITS.hpMax),
    stamina: z.number().int().min(0).max(LIMITS.staminaMax),
    maxStamina: z.number().int().min(1).max(LIMITS.staminaMax),
    neili: NeiliSchema.nullable(),
    currency: CurrencySchema,
    attributes: AttributesSchema,
    title: HonorificSchema.nullable(),
    epithet: HonorificSchema.nullable(),
    fate: HonorificSchema.nullable(),
    location: LocationRefSchema,
    version: z.number().int().min(0),
  })
  .strict()
  .refine((s) => s.hp <= s.maxHp, { message: 'hp 不得超过 maxHp', path: ['hp'] })
  .refine((s) => s.stamina <= s.maxStamina, { message: 'stamina 不得超过 maxStamina', path: ['stamina'] })
  .refine((s) => (s.neili !== null) === realmHasNeili(s.realm), {
    message: '内力仅后天及以上境界拥有',
    path: ['neili'],
  });
export type PlayerState = z.infer<typeof PlayerStateSchema>;
