import { z } from 'zod';

/** 世界时间：服务端权威时间与离线规则，客户端据此显示倒计时与说明 */
export const WorldTimeResponseSchema = z
  .object({
    serverNow: z.number().int().min(0),
    offline: z
      .object({
        /** 距上次接触超过该时长即视为离线 */
        thresholdMs: z.number().int().min(0),
        /** 单次结算最多计入的离线时长 */
        capMs: z.number().int().min(0),
        efficiencyPercent: z.number().int().min(0).max(100),
      })
      .strict(),
    /** 系统时间被调到过去时，游戏时间暂停追平的时长；正常为 0 */
    clockBehindMs: z.number().int().min(0),
  })
  .strict();
export type WorldTimeResponse = z.infer<typeof WorldTimeResponseSchema>;
