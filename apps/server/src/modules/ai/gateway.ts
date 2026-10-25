import type { AiStatusResponse } from '@jhz/contracts';
import type { Clock } from '../../shared/runtime.js';
import type { AiCallLogStore } from '../store/types.js';
import type { AiConfig } from './config.js';
import { redactSecrets } from './redact.js';
import { AiError, type AiProvider, type AiRequest, type AiResponse } from './types.js';

/** 本地日期 YYYY-MM-DD，用于每日额度统计 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface AiGateway {
  readonly enabled: boolean;
  /** 发起一次受控的 AI 调用：检查启用状态、输入上限、每日额度，预占额度，调用，记录元数据 */
  complete(req: AiRequest, opts?: { actionId?: string | null }): Promise<AiResponse & { callId: string }>;
  status(): AiStatusResponse;
}

export interface GatewayDeps {
  config: AiConfig;
  /** 未启用时为 undefined */
  provider?: AiProvider;
  log: AiCallLogStore;
  clock: Clock;
}

export function createAiGateway({ config, provider, log, clock }: GatewayDeps): AiGateway {
  const enabled = !!provider && config.provider !== 'none';
  const secrets = [config.apiKey];

  return {
    enabled,

    async complete(req, opts = {}) {
      if (!enabled || !provider) throw new AiError('DISABLED', config.reason ?? 'AI 未启用');

      // 1) 输入上限：超过则根本不发出，也不占用额度
      const requestChars = req.messages.reduce((n, m) => n + m.content.length, 0);
      if (requestChars > config.maxInputChars) {
        throw new AiError('INPUT_TOO_LARGE', `请求内容 ${requestChars} 字符，超过上限 ${config.maxInputChars}`);
      }

      // 2) 每日额度：检查与预占在同一个同步步骤内，并发调用也不会超出上限
      const now = clock.now();
      const day = localDay(now);
      if (log.usedOn(day) >= config.dailyCallLimit) {
        throw new AiError('BUDGET_EXCEEDED', `今日 AI 调用已达上限（${config.dailyCallLimit} 次）`);
      }
      const callId = log.reserve({ actionId: opts.actionId ?? null, purpose: req.purpose, provider: provider.name, model: provider.model, day, requestChars, at: now });

      // 3) 输出上限始终不超过配置
      const capped: AiRequest = { ...req, maxTokens: Math.min(req.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens) };
      const started = Date.now();
      try {
        const res = await provider.complete(capped);
        log.finish(callId, {
          status: 'ok',
          errorKind: null,
          attempts: res.attempts,
          latencyMs: res.latencyMs || Date.now() - started,
          promptTokens: res.usage.promptTokens,
          completionTokens: res.usage.completionTokens,
          totalTokens: res.usage.totalTokens,
          responseChars: res.text.length,
        });
        return { ...res, callId };
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError('BAD_RESPONSE', redactSecrets(String((e as Error)?.message ?? e), secrets));
        log.finish(callId, { status: 'error', errorKind: err.kind, attempts: 0, latencyMs: Date.now() - started, promptTokens: null, completionTokens: null, totalTokens: null, responseChars: null });
        throw err;
      }
    },

    status() {
      const used = log.usedOn(localDay(clock.now()));
      return {
        enabled,
        provider: config.provider,
        model: enabled ? provider!.model : null,
        reason: enabled ? null : (config.reason ?? 'AI 未启用'),
        dailyLimit: config.dailyCallLimit,
        usedToday: used,
        remaining: Math.max(0, config.dailyCallLimit - used),
        maxOutputTokens: config.maxOutputTokens,
      };
    },
  };
}

/** 根据配置创建供应商；未启用返回 undefined */
export function providerFromConfig(config: AiConfig, deps: { createOpenAi: (c: AiConfig) => AiProvider; createMock: (model: string) => AiProvider }): AiProvider | undefined {
  if (config.provider === 'openai-compatible') return deps.createOpenAi(config);
  if (config.provider === 'mock') return deps.createMock(config.model);
  return undefined;
}
