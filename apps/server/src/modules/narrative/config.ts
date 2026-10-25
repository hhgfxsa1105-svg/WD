import { z } from 'zod';

/** off：不生成 AI 叙事；important：只对突破等重要事件；all：所有固定行动与突破 */
export type NarrateMode = 'off' | 'important' | 'all';

export interface NarrateConfig {
  mode: NarrateMode;
  /** 单次叙事的等待上限；超时按失败处理，行动结果不受影响 */
  timeoutMs: number;
  /** 每日叙事调用上限（与总调用上限独立，用尽后回退模板） */
  dailyLimit: number;
  /** 叙事输出 token 上限 */
  maxTokens: number;
}

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

const Schema = z.object({
  AI_NARRATE: z.enum(['off', 'important', 'all']).default('important'),
  AI_NARRATE_TIMEOUT_MS: int(8000, 500, 60_000),
  AI_NARRATE_DAILY_LIMIT: int(50, 0, 100_000),
  AI_NARRATE_MAX_TOKENS: int(200, 16, 1000),
});

export const OFF_NARRATE: NarrateConfig = { mode: 'off', timeoutMs: 8000, dailyLimit: 50, maxTokens: 200 };

/** 读取叙事配置；配置不合法时退回「关闭」，永不抛出 */
export function loadNarrateConfig(env: NodeJS.ProcessEnv = process.env): NarrateConfig {
  const p = Schema.safeParse(env);
  if (!p.success) return OFF_NARRATE;
  const e = p.data;
  return { mode: e.AI_NARRATE, timeoutMs: e.AI_NARRATE_TIMEOUT_MS, dailyLimit: e.AI_NARRATE_DAILY_LIMIT, maxTokens: e.AI_NARRATE_MAX_TOKENS };
}
