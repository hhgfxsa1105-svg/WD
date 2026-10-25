import { z } from 'zod';
import { StateChangeSchema } from './action.js';
import { AttributeKeySchema } from './enums.js';
import { LogRecordSchema } from './log.js';
import { NpcStatusSchema } from './npc.js';
import { PlayerStateSchema } from './player.js';

/**
 * 个人轨：玩家自定义行为（预设行动之外）→ AI 提议一个个人事件 → 玩家选择进行或放弃 → 服务端判定成败。
 *
 * 信任边界：提议是不可信输入。效果只能来自下面这份白名单，没有物品、货币、经验、玩家数值字段，
 * 模型无从提交；难度档位与属性由模型选，**成败由服务端按属性和种子随机数决定**。
 */

export const PERSONAL_TIERS = ['small', 'medium', 'large'] as const;
export const PersonalTierSchema = z.enum(PERSONAL_TIERS);
export type PersonalTier = z.infer<typeof PersonalTierSchema>;

export const PERSONAL_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export const PersonalDifficultySchema = z.enum(PERSONAL_DIFFICULTIES);
export type PersonalDifficulty = z.infer<typeof PersonalDifficultySchema>;

export const PERSONAL_STATES = ['active', 'resolved', 'abandoned', 'expired'] as const;
export const PersonalStateSchema = z.enum(PERSONAL_STATES);
export type PersonalState = z.infer<typeof PersonalStateSchema>;

const Id = z.string().regex(/^[a-z0-9_]{1,64}$/);
const small = z.number().int().min(-5).max(5);

/** 效果白名单。每一种都是对「世界状态」的小幅改动，AI 不能给玩家任何资源 */
export const PersonalEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npc_move'), npcId: Id, locationId: Id }).strict(),
  z.object({ kind: z.literal('npc_status'), npcId: Id, status: NpcStatusSchema }).strict(),
  /** 临时封锁一个死胡同地点（固定 1 个游戏日后自动恢复） */
  z.object({ kind: z.literal('location_block'), locationId: Id, reason: z.string().min(2).max(30) }).strict(),
  z.object({ kind: z.literal('faction_strength'), factionId: Id, delta: small }).strict(),
  z.object({ kind: z.literal('faction_attitude'), factionId: Id, delta: small }).strict(),
  z.object({ kind: z.literal('faction_relation'), a: Id, b: Id, delta: small }).strict(),
  /** 某人对玩家的态度（好感 / 信任 / 敌意） */
  z.object({ kind: z.literal('npc_attitude'), npcId: Id, affinity: small.optional(), trust: small.optional(), hostility: small.optional() }).strict(),
  z.object({ kind: z.literal('rumor'), text: z.string().min(4).max(80) }).strict(),
]);
export type PersonalEffect = z.infer<typeof PersonalEffectSchema>;

const Branch = (maxEffects: number) =>
  z.object({ narrative: z.string().min(8).max(200), effects: z.array(PersonalEffectSchema).max(maxEffects) }).strict();

export const PersonalProposalSchema = z
  .object({
    title: z.string().min(2).max(24),
    /** 事件开场：展示给玩家的一小段 */
    intro: z.string().min(8).max(120),
    tier: PersonalTierSchema,
    difficulty: PersonalDifficultySchema,
    /** 判定用的属性（神 / 力 / 敏 / 根 / 悟 / 福） */
    skill: AttributeKeySchema,
    success: Branch(3),
    failure: Branch(2),
  })
  .strict();
export type PersonalProposal = z.infer<typeof PersonalProposalSchema>;

/** 存档与存储里的个人事件记录 */
export const PersonalEventRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** 提交这次自定义行为的幂等键；存档不带 */
    idempotencyKey: z.string().min(1).max(128).nullable(),
    fingerprint: z.string().max(64).nullable(),
    state: PersonalStateSchema,
    /** 模型对玩家意图的一句话复述（来自解析步骤，≤80 字） */
    intent: z.string().min(1).max(80),
    proposal: PersonalProposalSchema,
    createdAtMinutes: z.number().int().min(0),
    /** 逾期未处理则作废（算失败） */
    expiresAtMinutes: z.number().int().min(0),
    /** 服务端算出的成功率（百分点） */
    chancePercent: z.number().int().min(0).max(100),
    /** 了结后：成败。进行中为 null；放弃 / 作废一律是 failure */
    outcome: z.enum(['success', 'failure']).nullable(),
    /** 仅 resolved：掷点 [0, 100) */
    roll: z.number().min(0).max(100).nullable(),
    resolvedAtMinutes: z.number().int().min(0).nullable(),
    /** 成功 / 失败分支里的地点封锁：到期自动恢复 */
    lock: z.object({ locationId: Id, reason: z.string().min(2).max(30), untilMinutes: z.number().int().min(0), released: z.boolean() }).strict().nullable(),
  })
  .strict()
  .refine((e) => (e.state === 'active') === (e.outcome === null), '进行中的事件没有结果，其余必须有')
  .refine((e) => (e.state === 'resolved') === (e.roll !== null), '只有已进行的事件有掷点')
  .refine((e) => (e.state === 'active') === (e.resolvedAtMinutes === null), '进行中的事件没有了结时间，其余必须有')
  .refine((e) => e.state === 'resolved' || e.outcome !== 'success', '放弃或作废的事件只能是失败');
export type PersonalEventRecord = z.infer<typeof PersonalEventRecordSchema>;

/** 玩家看到的个人事件 */
export const PersonalEventViewSchema = z
  .object({
    id: z.string(),
    state: PersonalStateSchema,
    title: z.string(),
    intro: z.string(),
    tier: PersonalTierSchema,
    /** 进行需要的游戏分钟与体力（由服务端按档位决定） */
    minutes: z.number().int(),
    staminaCost: z.number().int(),
    difficulty: PersonalDifficultySchema,
    skill: AttributeKeySchema,
    chancePercent: z.number().int().min(0).max(100),
    expiresAt: z.object({ minutes: z.number().int(), label: z.string() }).strict(),
    outcome: z.enum(['success', 'failure']).nullable(),
    /** 了结后的叙述 */
    result: z.string().nullable(),
  })
  .strict();
export type PersonalEventView = z.infer<typeof PersonalEventViewSchema>;

export const PersonalListResponseSchema = z
  .object({ active: PersonalEventViewSchema.nullable(), recent: z.array(PersonalEventViewSchema).max(20) })
  .strict();
export type PersonalListResponse = z.infer<typeof PersonalListResponseSchema>;

export const PersonalResolveResponseSchema = z
  .object({
    narrative: z.string().max(4000),
    outcome: z.enum(['success', 'failure']),
    changes: z.array(StateChangeSchema).max(16),
    player: PlayerStateSchema,
    log: LogRecordSchema.nullable(),
    event: PersonalEventViewSchema,
  })
  .strict();
export type PersonalResolveResponse = z.infer<typeof PersonalResolveResponseSchema>;
