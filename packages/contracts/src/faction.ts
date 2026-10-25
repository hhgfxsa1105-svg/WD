import { z } from 'zod';

const FactionIdSchema = z.string().regex(/^fac_[a-z0-9_]+$/).max(40);

/** 势力的可变状态（名字、简介来自静态定义）；也是存档里的势力记录 */
export const FactionStateSchema = z
  .object({
    id: FactionIdSchema,
    /** 实力 0..100 */
    strength: z.number().int().min(0).max(100),
    /** 该势力对玩家的态度 −100..100 */
    attitude: z.number().int().min(-100).max(100),
  })
  .strict();
export type FactionState = z.infer<typeof FactionStateSchema>;

/** 两个势力之间的关系（a < b，双向共用一个数值） */
export const FactionRelationSchema = z
  .object({ a: FactionIdSchema, b: FactionIdSchema, value: z.number().int().min(-100).max(100) })
  .strict()
  .refine((r) => r.a < r.b, '势力关系必须按 ID 排序（a < b）');
export type FactionRelation = z.infer<typeof FactionRelationSchema>;

export const FACTION_CHANGE_KINDS = ['strength', 'attitude', 'relation'] as const;
/** 一次事件造成的一项实际变化（夹到范围之后） */
export const FactionChangeSchema = z
  .object({
    kind: z.enum(FACTION_CHANGE_KINDS),
    /** strength / attitude 的势力；relation 时为关系的 a */
    faction: FactionIdSchema,
    /** 仅 relation：关系的 b */
    other: FactionIdSchema.nullable(),
    from: z.number().int().min(-100).max(100),
    to: z.number().int().min(-100).max(100),
  })
  .strict()
  .refine((c) => (c.kind === 'relation') === (c.other !== null), '只有势力关系变化才有对方势力');
export type FactionChange = z.infer<typeof FactionChangeSchema>;

/** 势力历史：每个造成了势力变化的事件一条（事件 ID 唯一） */
export const FactionHistorySchema = z
  .object({
    id: z.string().min(1).max(64),
    eventId: z.string().regex(/^evt_[a-z0-9_]+$/).max(48),
    gameMinutes: z.number().int().min(0),
    text: z.string().min(1).max(400),
    changes: z.array(FactionChangeSchema).min(1).max(16),
  })
  .strict();
export type FactionHistory = z.infer<typeof FactionHistorySchema>;

/** 玩家可见的势力现状：用描述而不是裸数字，但也给出数值便于核对 */
export const FactionViewSchema = z
  .object({
    id: FactionIdSchema,
    name: z.string().min(1).max(20),
    summary: z.string().max(120),
    strength: z.number().int().min(0).max(100),
    strengthLabel: z.string().max(10),
    attitude: z.number().int().min(-100).max(100),
    attitudeLabel: z.string().max(10),
  })
  .strict();
export type FactionView = z.infer<typeof FactionViewSchema>;

export const FactionRelationViewSchema = z
  .object({ a: FactionIdSchema, b: FactionIdSchema, aName: z.string(), bName: z.string(), value: z.number().int(), label: z.string().max(10) })
  .strict();

export const FactionHistoryViewSchema = z
  .object({
    eventId: z.string(),
    title: z.string().max(40),
    gameMinutes: z.number().int().min(0),
    when: z.string().max(32),
    text: z.string().max(400),
    /** 每项变化的一句话，如「黑风寨 实力 40 → 32」 */
    changes: z.array(z.string().max(80)).max(16),
  })
  .strict();

export const FactionsResponseSchema = z
  .object({
    factions: z.array(FactionViewSchema).max(50),
    relations: z.array(FactionRelationViewSchema).max(200),
    /** 最近的在前 */
    history: z.array(FactionHistoryViewSchema).max(100),
  })
  .strict();
export type FactionsResponse = z.infer<typeof FactionsResponseSchema>;
