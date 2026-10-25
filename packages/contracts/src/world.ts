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
    /** 游戏时间：只由玩家行动和放置修炼推进，与现实时间无关 */
    game: z
      .object({
        /** 游戏分钟（第 1 天 00:00 起算） */
        minutes: z.number().int().min(0),
        day: z.number().int().min(1),
        /** 时辰地支，如「巳」 */
        shichen: z.string().min(1).max(2),
        /** 展示文字，如「第 3 天 · 巳时」 */
        label: z.string().min(1).max(32),
      })
      .strict(),
  })
  .strict();
export type WorldTimeResponse = z.infer<typeof WorldTimeResponseSchema>;
