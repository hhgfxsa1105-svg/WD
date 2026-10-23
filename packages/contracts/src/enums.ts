import { z } from 'zod';

/** 境界，按晋级顺序排列；后天（含）以上才拥有内力 */
export const REALMS = [
  'body_tempering', // 炼体
  'opening', // 通窍
  'houtian', // 后天
  'xiantian', // 先天
  'grandmaster', // 宗师
  'mingshen', // 明神
  'land_immortal', // 陆地神仙
] as const;
export const RealmSchema = z.enum(REALMS);
export type Realm = z.infer<typeof RealmSchema>;

/** 评级：功法、头衔、称号、命格共用（凡 / 黄 / 玄 / 地 / 天） */
export const GRADES = ['fan', 'huang', 'xuan', 'di', 'tian'] as const;
export const GradeSchema = z.enum(GRADES);
export type Grade = z.infer<typeof GradeSchema>;

/** 六维：神、力、敏、根、悟、福。魅力为隐藏属性，仅服务端持有，不进入契约 */
export const ATTRIBUTE_KEYS = ['spirit', 'strength', 'agility', 'constitution', 'comprehension', 'fortune'] as const;
export const AttributeKeySchema = z.enum(ATTRIBUTE_KEYS);
export type AttributeKey = z.infer<typeof AttributeKeySchema>;

/** 名号效果类别（数据驱动，由程序结算） */
export const EFFECT_KINDS = ['attribute_bonus', 'exp_multiplier', 'affinity_modifier', 'chance_modifier'] as const;
export const EffectKindSchema = z.enum(EFFECT_KINDS);
export type EffectKind = z.infer<typeof EffectKindSchema>;

/** 行动可改变的数值（用于结果摘要） */
export const CHANGE_STATS = ['stamina', 'hp', 'neili', 'realmProgress', 'maxHp', 'maxStamina'] as const;
export const ChangeStatSchema = z.enum(CHANGE_STATS);
export type ChangeStat = z.infer<typeof ChangeStatSchema>;

export const ITEM_KINDS = ['breakthrough_pill'] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const CULTIVATION_STATUSES = ['running', 'stopped'] as const;
export const CultivationStatusSchema = z.enum(CULTIVATION_STATUSES);
export type CultivationStatus = z.infer<typeof CultivationStatusSchema>;

export const ACTION_KINDS = ['fixed', 'breakthrough'] as const;

export const LOG_TYPES = ['fixed', 'breakthrough', 'idle', 'system'] as const;
export const LogTypeSchema = z.enum(LOG_TYPES);
export type LogType = z.infer<typeof LogTypeSchema>;

export const FIXED_ACTION_IDS = ['cultivate', 'rest'] as const;
export const FixedActionIdSchema = z.enum(FIXED_ACTION_IDS);
export type FixedActionId = z.infer<typeof FixedActionIdSchema>;

/** 行动状态机（技术说明书 5.1）：RECEIVED → … → COMPLETED，可失败转入 FAILED */
export const ACTION_STATUSES = [
  'RECEIVED',
  'PARSING',
  'VALIDATING',
  'RESOLVING',
  'COMMITTED',
  'NARRATED',
  'COMPLETED',
  'FAILED',
] as const;
export const ActionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'INTERNAL_ERROR',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
