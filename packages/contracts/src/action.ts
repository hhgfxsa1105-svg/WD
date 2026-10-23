import { z } from 'zod';
import { ActionStatusSchema, ChangeStatSchema, FixedActionIdSchema } from './enums.js';
import { ItemIdSchema } from './inventory.js';
import { LogRecordSchema } from './log.js';
import { PlayerStateSchema } from './player.js';
import { LIMITS } from './limits.js';

/** 浏览器只提交意图；资源数值与结果一律由服务端计算 */
export const IdempotencyKeySchema = z
  .string()
  .min(LIMITS.idempotencyKey.min)
  .max(LIMITS.idempotencyKey.max)
  .regex(/^[A-Za-z0-9_-]+$/, '仅允许字母、数字、下划线与连字符');

export const SubmitActionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), idempotencyKey: IdempotencyKeySchema, actionId: FixedActionIdSchema }).strict(),
  z
    .object({
      kind: z.literal('free'),
      idempotencyKey: IdempotencyKeySchema,
      input: z.string().trim().min(LIMITS.freeInput.min).max(LIMITS.freeInput.max),
    })
    .strict(),
  /** 突破：可选带一枚突破丹药（库存中的物品 ID）；成功率与结果由服务端计算 */
  z
    .object({
      kind: z.literal('breakthrough'),
      idempotencyKey: IdempotencyKeySchema,
      pillItemId: ItemIdSchema.nullable(),
    })
    .strict(),
]);
export type SubmitActionRequest = z.infer<typeof SubmitActionRequestSchema>;

export const StateChangeSchema = z
  .object({ stat: ChangeStatSchema, delta: z.number().int().min(-1_000_000).max(1_000_000) })
  .strict();
export type StateChange = z.infer<typeof StateChangeSchema>;

/** 行动结果：状态变化由服务端结算；narrative 在叙事生成失败时为 null */
export const ActionResponseSchema = z
  .object({
    actionId: z.string().min(1),
    status: ActionStatusSchema,
    narrative: z.string().max(4000).nullable(),
    changes: z.array(StateChangeSchema).max(16),
    /** 仅突破行动有值：成功率与掷点便于核对 */
    breakthrough: z
      .object({
        outcome: z.enum(['success', 'failure']),
        chancePercent: z.number().min(0).max(100),
        roll: z.number().min(0).max(100),
      })
      .strict()
      .nullable(),
    /** 本次行动写入的日志记录（重试回放时与首次相同） */
    log: LogRecordSchema.nullable(),
    player: PlayerStateSchema,
  })
  .strict();
export type ActionResponse = z.infer<typeof ActionResponseSchema>;
