import { z } from 'zod';
import { CultivationStatusSchema } from './enums.js';
import { StateChangeSchema } from './action.js';
import { PlayerStateSchema } from './player.js';

export const CultivationJobSchema = z
  .object({
    methodId: z.string().min(1).max(64),
    status: CultivationStatusSchema,
    /** 服务端时间，毫秒时间戳 */
    startedAt: z.number().int().min(0),
    lastSettledAt: z.number().int().min(0),
  })
  .strict();
export type CultivationJob = z.infer<typeof CultivationJobSchema>;

/** 放置修炼接口的统一响应；job 为 null 表示当前没有进行中的修炼 */
export const CultivationResponseSchema = z
  .object({
    job: CultivationJobSchema.nullable(),
    player: PlayerStateSchema,
    /** 本次结算获得的变化；仅查询时为空 */
    changes: z.array(StateChangeSchema).max(16),
    /** 本次结算的时间片数量 */
    ticks: z.number().int().min(0),
    serverNow: z.number().int().min(0),
    /** 本次结算按「离线」处理时的说明；在线结算为 null */
    offline: z
      .object({
        /** 距上次接触的时长 */
        gapMs: z.number().int().min(0),
        /** 实际计入的时长（受离线上限约束） */
        countedMs: z.number().int().min(0),
        /** 是否触及上限而被截断 */
        capped: z.boolean(),
        efficiencyPercent: z.number().int().min(0).max(100),
      })
      .strict()
      .nullable(),
    notice: z.string().max(200).nullable(),
  })
  .strict();
export type CultivationResponse = z.infer<typeof CultivationResponseSchema>;
