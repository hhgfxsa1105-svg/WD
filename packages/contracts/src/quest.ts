import { z } from 'zod';
import { EntityIdSchema } from './ai-plan.js';

/** 任务状态机：locked → available → active → completed | failed（completed、failed 为终态） */
export const QUEST_STATUSES = ['locked', 'available', 'active', 'completed', 'failed'] as const;
export const QuestStatusSchema = z.enum(QUEST_STATUSES);
export type QuestStatus = z.infer<typeof QuestStatusSchema>;

/** 玩家可做的任务操作 */
export const QUEST_OPS = ['accept', 'claim', 'abandon'] as const;
export type QuestOp = (typeof QUEST_OPS)[number];

/** 任务的可变状态；名字、步骤文字与奖励来自静态定义 */
export const QuestStateSchema = z
  .object({
    id: EntityIdSchema,
    status: QuestStatusSchema,
    /** 已完成的步骤数（0..步骤总数） */
    stepIndex: z.number().int().min(0).max(50),
    /** 奖励是否已领取（只有 completed 才可能为 true，且只能领取一次） */
    claimed: z.boolean(),
  })
  .strict();
export type QuestState = z.infer<typeof QuestStateSchema>;

export const QuestViewSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string().min(1).max(32),
    summary: z.string().max(200),
    giver: z.string().max(32).nullable(),
    status: QuestStatusSchema,
    steps: z.array(z.object({ text: z.string().min(1).max(80), done: z.boolean() }).strict()).max(20),
    /** 奖励说明文字，如「铜钱 100」 */
    reward: z.array(z.string().max(40)).max(8),
    claimed: z.boolean(),
    /** 前置任务未完成时的提示；已解锁为 null */
    lockedBy: z.string().max(32).nullable(),
  })
  .strict();
export type QuestView = z.infer<typeof QuestViewSchema>;

export const QuestListResponseSchema = z.object({ quests: z.array(QuestViewSchema).max(100) }).strict();
export type QuestListResponse = z.infer<typeof QuestListResponseSchema>;
