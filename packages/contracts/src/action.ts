import { z } from 'zod';
import { ActionStatusSchema, FixedActionIdSchema } from './enums.js';
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
]);
export type SubmitActionRequest = z.infer<typeof SubmitActionRequestSchema>;

export const ActionResponseSchema = z
  .object({
    actionId: z.string().min(1),
    status: ActionStatusSchema,
    narrative: z.string().max(4000).nullable(),
  })
  .strict();
export type ActionResponse = z.infer<typeof ActionResponseSchema>;
