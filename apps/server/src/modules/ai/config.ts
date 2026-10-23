import { z } from 'zod';

export type AiProviderName = 'none' | 'mock' | 'openai-compatible';

export interface AiConfig {
  provider: AiProviderName;
  /** 未启用的原因；已启用时为 null */
  reason: string | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  jsonMode: 'auto' | 'on' | 'off';
  /** 单次调用输出 token 上限 */
  maxOutputTokens: number;
  /** 单次请求内容（所有消息）的字符数上限，超过则不发出 */
  maxInputChars: number;
  /** 每日调用次数上限（按本地日期统计，持久化） */
  dailyCallLimit: number;
}

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def);

const Schema = z.object({
  AI_PROVIDER: z.string().trim().toLowerCase().default(''),
  AI_BASE_URL: z.string().trim().default(''),
  AI_API_KEY: z.string().trim().default(''),
  AI_MODEL: z.string().trim().default(''),
  AI_TIMEOUT_MS: int(20_000, 1000, 120_000),
  AI_MAX_RETRIES: int(2, 0, 5),
  AI_BACKOFF_MS: int(500, 0, 10_000),
  AI_JSON_MODE: z.enum(['auto', 'on', 'off']).default('auto'),
  AI_MAX_OUTPUT_TOKENS: int(1000, 16, 8000),
  AI_MAX_INPUT_CHARS: int(6000, 200, 100_000),
  AI_DAILY_CALL_LIMIT: int(200, 0, 100_000),
});

const disabled = (reason: string, base: Omit<AiConfig, 'provider' | 'reason'>): AiConfig => ({ ...base, provider: 'none', reason });

/**
 * 读取 AI 配置。永不抛异常：配置缺失或不合法时返回「未启用」及原因，基础游戏功能不受影响。
 * 密钥只存在于返回对象的 apiKey 字段，调用方不得写入日志或接口响应。
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const parsed = Schema.safeParse(env);
  const fallback = Schema.parse({});
  const baseOf = (e: z.infer<typeof Schema>): Omit<AiConfig, 'provider' | 'reason'> => ({
    baseUrl: e.AI_BASE_URL,
    apiKey: e.AI_API_KEY,
    model: e.AI_MODEL,
    timeoutMs: e.AI_TIMEOUT_MS,
    maxRetries: e.AI_MAX_RETRIES,
    backoffMs: e.AI_BACKOFF_MS,
    jsonMode: e.AI_JSON_MODE,
    maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
    maxInputChars: e.AI_MAX_INPUT_CHARS,
    dailyCallLimit: e.AI_DAILY_CALL_LIMIT,
  });
  if (!parsed.success) {
    const bad = parsed.error.issues[0]?.path.join('.') ?? '';
    return disabled(`AI 配置项 ${bad} 的值不合法`, { ...baseOf(fallback) });
  }
  const e = parsed.data;
  const base = baseOf(e);

  if (e.AI_PROVIDER === '' || e.AI_PROVIDER === 'none') return disabled('未配置 AI（AI_PROVIDER 为空）', base);
  if (e.AI_PROVIDER === 'mock') return { ...base, provider: 'mock', reason: null, model: e.AI_MODEL || 'keyword-mock' };

  if (e.AI_PROVIDER === 'openai-compatible' || e.AI_PROVIDER === 'openai') {
    const missing = [!e.AI_BASE_URL && 'AI_BASE_URL', !e.AI_API_KEY && 'AI_API_KEY', !e.AI_MODEL && 'AI_MODEL'].filter(Boolean);
    if (missing.length > 0) return disabled(`AI 配置不完整：缺少 ${missing.join('、')}`, base);
    let url: URL;
    try {
      url = new URL(e.AI_BASE_URL);
    } catch {
      return disabled('AI_BASE_URL 不是有效的地址', base);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return disabled('AI_BASE_URL 必须以 http:// 或 https:// 开头', base);
    return { ...base, provider: 'openai-compatible', reason: null };
  }
  return disabled(`不支持的 AI_PROVIDER：${e.AI_PROVIDER.slice(0, 30)}（可选：openai-compatible、mock，留空为关闭）`, base);
}

/** 用于日志与诊断的配置摘要：不含密钥与地址 */
export function describeAiConfig(c: AiConfig): string {
  return c.provider === 'none'
    ? `AI 未启用（${c.reason}）`
    : `AI 已启用：${c.provider}，模型 ${c.model}，每日上限 ${c.dailyCallLimit} 次，输出上限 ${c.maxOutputTokens} token`;
}
