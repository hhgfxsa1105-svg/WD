import { AiError, type AiProvider, type AiRequest, type AiResponse, type AiUsage } from './types.js';
import { redactSecrets, safeSnippet } from './redact.js';

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  jsonMode: 'auto' | 'on' | 'off';
  /** 以下三项仅供测试注入 */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxBackoffMs?: number;
}

/** 兼容 http://host/v1、http://host/v1/ 与完整的 …/chat/completions 三种写法 */
export function chatCompletionsUrl(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(u) ? u : `${u}/chat/completions`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const sec = Number(h);
  if (Number.isFinite(sec) && sec >= 0) return Math.floor(sec * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/** 供应商明确表示不支持 JSON 模式（response_format）时返回 true */
function looksLikeJsonModeRejection(body: string): boolean {
  return /response_format|json_object|json mode|json_schema/i.test(body);
}

/**
 * OpenAI 兼容协议（POST {base}/chat/completions）的供应商适配器，
 * 适用于绝大多数国产模型与中转站。不依赖任何 SDK，使用 Node 自带 fetch。
 *
 * - 超时：每次 HTTP 请求（含读取响应体）受 timeoutMs 约束；
 * - 重试：仅对超时、网络错误、429、5xx，指数退避并尊重 Retry-After（有上限）；
 * - JSON 模式：优先请求；供应商拒绝时自动降级为普通模式，并记住该供应商不支持；
 * - 安全：错误信息不含密钥（已脱敏并限长），不记录提示词与回复。
 */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatOptions): AiProvider {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const maxBackoff = opts.maxBackoffMs ?? 8000;
  const url = chatCompletionsUrl(opts.baseUrl);
  const secrets = [opts.apiKey];
  /** undefined = 尚未探测；false = 已确认不支持 */
  let jsonSupported: boolean | undefined;

  async function once(req: AiRequest, useJson: boolean, maxTokens: number | undefined): Promise<Omit<AiResponse, 'attempts' | 'latencyMs'>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages,
        stream: false,
        temperature: req.temperature ?? 0.2,
      };
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      if (useJson) body.response_format = { type: 'json_object' };

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
      } catch (e) {
        if (ctl.signal.aborted) throw new AiError('TIMEOUT', `AI 服务在 ${opts.timeoutMs} ms 内没有响应`);
        const code = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code ?? '';
        throw new AiError('NETWORK', `无法连接 AI 服务${code ? `（${redactSecrets(String(code), secrets)}）` : ''}`);
      }

      let text: string;
      try {
        text = await res.text();
      } catch {
        if (ctl.signal.aborted) throw new AiError('TIMEOUT', `AI 服务在 ${opts.timeoutMs} ms 内没有返回完整内容`);
        throw new AiError('NETWORK', 'AI 服务的响应中断');
      }

      if (!res.ok) {
        const s = res.status;
        const detail = safeSnippet(text, secrets);
        if (s === 401 || s === 403) throw new AiError('AUTH', `AI 服务拒绝了请求（${s}）：密钥无效或无权限`, s);
        if (s === 429) throw new AiError('RATE_LIMITED', `AI 服务限流（429）${detail ? `：${detail}` : ''}`, s, parseRetryAfter(res.headers.get('retry-after')));
        if (s === 408) throw new AiError('TIMEOUT', 'AI 服务报告请求超时（408）', s);
        if (s >= 500) throw new AiError('SERVER_ERROR', `AI 服务内部错误（${s}）${detail ? `：${detail}` : ''}`, s, parseRetryAfter(res.headers.get('retry-after')));
        throw new AiError('BAD_REQUEST', `AI 服务认为请求不合法（${s}）${detail ? `：${detail}` : ''}`, s);
      }

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new AiError('BAD_RESPONSE', 'AI 服务返回的不是有效的 JSON');
      }
      return parseCompletion(data, opts.model, useJson);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'openai-compatible',
    model: opts.model,
    async complete(req) {
      const started = Date.now();
      let attempts = 0;
      let retriesLeft = opts.maxRetries;
      let retryIndex = 0;
      let useJson = !!req.json && opts.jsonMode !== 'off' && (opts.jsonMode === 'on' || jsonSupported !== false);
      const maxTokens = req.maxTokens;

      for (;;) {
        attempts++;
        try {
          const r = await once(req, useJson, maxTokens);
          if (useJson && opts.jsonMode === 'auto') jsonSupported = true;
          return { ...r, attempts, latencyMs: Date.now() - started };
        } catch (e) {
          if (!(e instanceof AiError)) throw new AiError('BAD_RESPONSE', redactSecrets(String((e as Error)?.message ?? e), secrets));
          // JSON 模式被供应商拒绝：降级为普通模式重试一次（不消耗重试额度）
          if (e.kind === 'BAD_REQUEST' && useJson && opts.jsonMode === 'auto' && looksLikeJsonModeRejection(e.message)) {
            jsonSupported = false;
            useJson = false;
            continue;
          }
          if (!e.retryable || retriesLeft <= 0) throw e;
          retriesLeft--;
          const backoff = Math.min(maxBackoff, opts.backoffMs * 2 ** retryIndex++) * (0.5 + random() / 2);
          await sleep(e.retryAfterMs !== undefined ? Math.min(maxBackoff, e.retryAfterMs) : backoff);
        }
      }
    },
  };
}

/** 解析 chat.completions 的响应；拒答、内容过滤、空内容都转为明确的错误 */
export function parseCompletion(data: unknown, fallbackModel: string, jsonModeUsed: boolean): Omit<AiResponse, 'attempts' | 'latencyMs'> {
  const d = data as {
    model?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[];
  };
  const choice = Array.isArray(d?.choices) ? d.choices[0] : undefined;
  if (!choice || typeof choice !== 'object') throw new AiError('BAD_RESPONSE', 'AI 服务返回的结果里没有 choices');

  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const refusal = choice.message?.refusal;
  if (finish === 'content_filter' || (typeof refusal === 'string' && refusal.trim() !== '')) {
    throw new AiError('REFUSED', 'AI 拒绝回答或内容被过滤');
  }

  const c = choice.message?.content;
  const text = Array.isArray(c)
    ? c.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
    : typeof c === 'string'
      ? c
      : '';
  if (text.trim() === '') throw new AiError('BAD_RESPONSE', 'AI 服务返回的内容为空');

  const u = d.usage ?? {};
  const usage: AiUsage = { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens) };
  return { text, model: typeof d.model === 'string' && d.model ? d.model.slice(0, 100) : fallbackModel, usage, finishReason: finish, jsonModeUsed };
}
