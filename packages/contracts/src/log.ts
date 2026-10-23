import { z } from 'zod';
import { LogTypeSchema, RealmSchema } from './enums.js';

/**
 * 玩家可见日志的结构化记录，由服务端在结算的同一事务里写入（审计事件的一部分）。
 * 文字排版（数值标签、小字）由前端根据这些字段渲染，因此刷新、重启后也能完整还原。
 */
export const LogRecordSchema = z
  .object({
    /** 单调递增的序号，也是排序依据 */
    id: z.number().int().min(1),
    /** 服务端时间，毫秒时间戳 */
    at: z.number().int().min(0),
    type: LogTypeSchema,
    narrative: z.string().max(4000),
    changes: z
      .array(z.object({ stat: z.string().min(1).max(32), delta: z.number().int() }).strict())
      .max(16),
    breakthrough: z
      .object({
        outcome: z.enum(['success', 'failure']),
        chancePercent: z.number().min(0).max(100),
        roll: z.number().min(0).max(100),
        pillName: z.string().max(32).nullable(),
        realmFrom: RealmSchema,
        realmTo: RealmSchema,
      })
      .strict()
      .nullable(),
    idle: z
      .object({
        ticks: z.number().int().min(0),
        offline: z
          .object({
            gapMs: z.number().int().min(0),
            countedMs: z.number().int().min(0),
            capped: z.boolean(),
            efficiencyPercent: z.number().int().min(0).max(100),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    /** 补充说明，如「修炼已圆满，可以尝试突破了」 */
    note: z.string().max(200).nullable(),
  })
  .strict();
export type LogRecord = z.infer<typeof LogRecordSchema>;

export const LogResponseSchema = z.object({ entries: z.array(LogRecordSchema).max(500) }).strict();
export type LogResponse = z.infer<typeof LogResponseSchema>;
