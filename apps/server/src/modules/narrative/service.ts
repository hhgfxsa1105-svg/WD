import { ActionResponseSchema, type ActionResponse, type LogType } from '@jhz/contracts';
import { vetNarrative } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/runtime.js';
import { advance } from '../action/service.js';
import { friendlyAiMessage } from '../action/free.js';
import { AiError, type AiGateway } from '../ai/index.js';
import { localDay } from '../ai/gateway.js';
import type { GameStore } from '../store/types.js';
import type { NarrateConfig } from './config.js';
import { buildNarrateMessages } from './prompt.js';

export interface NarratorDeps {
  store: GameStore;
  ai: AiGateway;
  clock: Clock;
  config: NarrateConfig;
}

type Outcome = { response: ActionResponse; error: AiError | null };

/**
 * 叙事与结算分离：行动先按规则结算并提交（模板叙事，状态 COMMITTED），
 * 之后才尝试用 AI 把叙事润色成更生动的文字。叙事只改文字，从不重新结算，也不能改任何数值。
 * 叙事失败（未启用、额度、超时、拒答、守卫不合格……）一律保持 COMMITTED + 模板叙事，可稍后手动重试。
 */
export function createNarrator({ store, ai, clock, config }: NarratorDeps) {
  const inflight = new Map<string, Promise<Outcome>>();

  /** 结算时决定：该类事件是否交给 AI 叙事（是则状态停在 COMMITTED，等待叙事） */
  function wants(type: LogType): boolean {
    if (!ai.enabled || config.mode === 'off') return false;
    if (type === 'breakthrough') return true;
    return config.mode === 'all' && type === 'fixed';
  }

  async function attempt(actionId: string): Promise<Outcome> {
    const stored = store.read((tx) => tx.getAction(actionId));
    if (!stored) throw new AppError('NOT_FOUND', '行动不存在');
    const current = stored.response;
    // 只有「已提交、叙事待补」的行动才会调用 AI；其余（已完成、重放）直接返回，不花一分钱
    if (stored.status !== 'COMMITTED' || !current.log) return { response: current, error: null };

    const day = localDay(clock.now());
    if (store.aiLog.usedOn(day, 'narrate') >= config.dailyLimit) {
      return { response: current, error: new AiError('BUDGET_EXCEEDED', '今日叙事额度已用完') };
    }

    let text: string;
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new AiError('TIMEOUT', '叙事生成超时')), config.timeoutMs);
      });
      try {
        const call = ai.complete({ messages: buildNarrateMessages(current.log), purpose: 'narrate', maxTokens: config.maxTokens, temperature: 0.8 }, { actionId });
        call.catch(() => undefined); // 超时后迟到的失败不再向上抛出
        text = (await Promise.race([call, timeout])).text;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { response: current, error: e instanceof AiError ? e : new AiError('BAD_RESPONSE', '叙事生成失败') };
    }

    const verdict = vetNarrative(text, { outcome: current.breakthrough?.outcome ?? null });
    if (!verdict.ok) return { response: current, error: new AiError('BAD_RESPONSE', `叙事未通过检查：${verdict.reason}`) };

    // 回写：事务内再次确认仍是 COMMITTED，避免重复覆盖；只改文字，不碰玩家状态
    const response = store.transact((tx) => {
      const fresh = tx.getAction(actionId);
      if (!fresh || fresh.status !== 'COMMITTED') return fresh?.response ?? current;
      const log = tx.replaceLogNarrative(actionId, verdict.text);
      const status = advance(advance(fresh.status, 'NARRATED'), 'COMPLETED');
      const next = ActionResponseSchema.parse({ ...fresh.response, status, narrative: verdict.text, log });
      tx.saveAction({ ...fresh, status, response: next });
      tx.appendEvent({ actionId, eventType: 'action.narrated', before: null, after: null, at: clock.now(), log: null });
      return next;
    });
    return { response, error: null };
  }

  function run(actionId: string): Promise<Outcome> {
    const existing = inflight.get(actionId);
    if (existing) return existing; // 同一行动的并发叙事请求合并为一次 AI 调用
    const p = attempt(actionId).finally(() => inflight.delete(actionId));
    inflight.set(actionId, p);
    return p;
  }

  return {
    wants,
    /** 结算刚提交后调用：尽力而为，失败时原样返回（不抛出） */
    async complete(response: ActionResponse): Promise<ActionResponse> {
      if (response.status !== 'COMMITTED') return response;
      try {
        return (await run(response.actionId)).response;
      } catch {
        return response;
      }
    },
    /** 玩家手动重试叙事：失败时抛出 AI_UNAVAILABLE（行动本身不受影响） */
    async retry(actionId: string): Promise<ActionResponse> {
      const { response, error } = await run(actionId);
      if (error) throw new AppError('AI_UNAVAILABLE', friendlyAiMessage(error.kind));
      return response;
    },
  };
}

export type Narrator = ReturnType<typeof createNarrator>;
