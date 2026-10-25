import { z } from 'zod';
import { ActionStatusSchema } from './enums.js';

/** 审计事件：关键状态变更的前后差异（只含发生变化的字段），不记录密钥或不必要的敏感数据 */
export const AuditEventSchema = z
  .object({
    seq: z.number().int().min(1),
    id: z.string().min(1),
    actorId: z.string().min(1),
    actionId: z.string().nullable(),
    eventType: z.string().min(1).max(64),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    at: z.number().int().min(0),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** 内部查询：行动及其审计事件（仅本机可访问） */
export const AuditActionResponseSchema = z
  .object({
    action: z
      .object({
        id: z.string().min(1),
        kind: z.string().min(1),
        status: ActionStatusSchema,
        idempotencyKey: z.string().min(1),
        createdAt: z.number().int().min(0),
      })
      .strict(),
    events: z.array(AuditEventSchema).max(100),
  })
  .strict();
export type AuditActionResponse = z.infer<typeof AuditActionResponseSchema>;
