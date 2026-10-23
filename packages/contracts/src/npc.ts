import { z } from 'zod';
import { LocationRefSchema } from './player.js';

export const NPC_STATUSES = ['active', 'away', 'resting'] as const;
export const NpcStatusSchema = z.enum(NPC_STATUSES);

const ID = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** 关系数值：方向为「从 NPC 指向对象」。范围固定，与数据库约束、规则函数一致 */
export const RELATION_LIMITS = {
  affinity: { min: -100, max: 100 },
  trust: { min: 0, max: 100 },
  hostility: { min: 0, max: 100 },
} as const;

export const RelationValuesSchema = z
  .object({
    affinity: z.number().int().min(RELATION_LIMITS.affinity.min).max(RELATION_LIMITS.affinity.max),
    trust: z.number().int().min(RELATION_LIMITS.trust.min).max(RELATION_LIMITS.trust.max),
    hostility: z.number().int().min(RELATION_LIMITS.hostility.min).max(RELATION_LIMITS.hostility.max),
  })
  .strict();
export type RelationValues = z.infer<typeof RelationValuesSchema>;

/** NPC 会变化的状态（名字、身份等显示文字来自静态定义，不在此处） */
export const NpcStateSchema = z
  .object({
    id: ID,
    locationId: ID,
    status: NpcStatusSchema,
    goals: z.array(z.string().min(1).max(60)).max(5),
  })
  .strict();
export type NpcState = z.infer<typeof NpcStateSchema>;

export const RelationshipSchema = RelationValuesSchema.extend({
  npcId: ID,
  targetType: z.enum(['player', 'npc']),
  targetId: ID,
}).strict();
export type Relationship = z.infer<typeof RelationshipSchema>;

/** 接口返回的 NPC 视图：静态显示文字 + 当前状态 + 对玩家的关系 */
export const NpcViewSchema = z
  .object({
    id: ID,
    name: z.string().min(1).max(32),
    role: z.string().min(1).max(32),
    intro: z.string().max(120),
    location: LocationRefSchema,
    status: NpcStatusSchema,
    goals: z.array(z.string().max(60)).max(5),
    /** 该 NPC 对玩家的态度 */
    towardPlayer: RelationValuesSchema,
  })
  .strict();
export type NpcView = z.infer<typeof NpcViewSchema>;

export const NpcListResponseSchema = z.object({ npcs: z.array(NpcViewSchema).max(200) }).strict();
export type NpcListResponse = z.infer<typeof NpcListResponseSchema>;
