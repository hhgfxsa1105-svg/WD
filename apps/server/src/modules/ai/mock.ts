import { NPC_DEFS } from '@jhz/game-rules';
import { AiError, type AiProvider, type AiRequest, type AiResponse } from './types.js';

/** 一步脚本：直接给文本、给完整响应、抛出错误、或按请求动态决定；delayMs 用于模拟慢响应 */
export type MockStep =
  | string
  | AiError
  | { text: string; finishReason?: string | null; usage?: AiResponse['usage']; delayMs?: number }
  | { delayMs: number; then: MockStep }
  | ((req: AiRequest) => MockStep | Promise<MockStep>);

export interface MockOptions {
  /** 按顺序消费；用完后使用 fallback */
  steps?: MockStep[];
  fallback?: MockStep;
  model?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface MockProvider extends AiProvider {
  readonly calls: AiRequest[];
}

const ZERO_USAGE = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };

/**
 * 可脚本化的模拟供应商：测试用，可注入超时、拒答、乱码、慢响应等故障，不需要真实密钥。
 * 它不是 openai-compatible 的替身协议，只模拟 AiProvider 层的行为。
 */
export function createMockProvider(opts: MockOptions = {}): MockProvider {
  const steps = [...(opts.steps ?? [])];
  const calls: AiRequest[] = [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const model = opts.model ?? 'mock-model';

  async function run(step: MockStep, req: AiRequest): Promise<AiResponse> {
    if (typeof step === 'function') return run(await step(req), req);
    if (step instanceof AiError) throw step;
    if (typeof step === 'string') return { text: step, model, usage: ZERO_USAGE, latencyMs: 0, attempts: 1, finishReason: 'stop', jsonModeUsed: !!req.json };
    if ('then' in step) {
      await sleep(step.delayMs);
      return run(step.then, req);
    }
    if (step.delayMs) await sleep(step.delayMs);
    return { text: step.text, model, usage: step.usage ?? ZERO_USAGE, latencyMs: step.delayMs ?? 0, attempts: 1, finishReason: step.finishReason ?? 'stop', jsonModeUsed: !!req.json };
  }

  return {
    name: 'mock',
    model,
    calls,
    async complete(req) {
      calls.push(req);
      const step = steps.length > 0 ? steps.shift()! : (opts.fallback ?? new AiError('BAD_RESPONSE', '模拟供应商没有更多脚本'));
      return run(step, req);
    },
  };
}

const plan = (action: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ intent: '', action_type: action, target: null, steps: [], risk_tags: [], narrative_context: '', needs_clarification: false, clarification: null, ...extra });

/**
 * 关键词规则版模拟：没有真实密钥时，本地也能体验自由输入（AI_PROVIDER=mock）。
 * 只读取最后一条用户消息（即玩家原话），按关键词给出动作方案；认不出的返回 other 触发澄清。
 */
export function createKeywordMockProvider(model = 'keyword-mock'): AiProvider {
  return {
    name: 'mock',
    model,
    async complete(req) {
      const text = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      let out: string;
      if (req.purpose === 'narrate') out = '你定了定神，按自己的意思行事，一切顺理成章。';
      else if (/突破|冲关|破境|冲击/.test(text)) {
        const pill = /丹/.test(text) && !/不(用|吃|使用)/.test(text);
        out = plan('breakthrough', { intent: '尝试突破', target: pill ? { type: 'item', id: 'pill_breakthrough_fan' } : null });
      } else if (/(停止|结束).*(修炼|挂机)|不.*(修炼|挂机)了/.test(text)) out = plan('stop_idle', { intent: '停止放置修炼' });
      else if (/挂机|放置|(开始|继续).*修炼/.test(text)) out = plan('start_idle', { intent: '开始放置修炼' });
      else if (/修炼|打坐|练功|修行/.test(text)) out = plan('cultivate', { intent: '修炼' });
      else if (/休息|歇|睡/.test(text)) out = plan('rest', { intent: '休息' });
      else if (/状态|属性|查看|看看自己/.test(text)) out = plan('check_status', { intent: '查看状态' });
      else if (/聊|谈|说话|问问|拜见|招呼|问候|拜访|找|见/.test(text)) {
        const alias: Record<string, RegExp> = { npc_master_qingyun: /掌门|青云真人/, npc_senior_sister: /大师姐|苏晚晴/, npc_gate_guard: /守门|赵铁牛/, npc_librarian: /执事|陆先生/ };
        const id = Object.entries(NPC_DEFS).find(([k, d]) => text.includes(d.name) || alias[k]?.test(text))?.[0];
        out = plan('talk', { intent: '与人交谈', target: id ? { type: 'npc', id } : null });
      }
      else out = plan('other', { intent: '不明', needs_clarification: true, clarification: '没太明白你想做什么，可以说「修炼」「休息」或「突破」。' });
      return { text: out, model, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 0, attempts: 1, finishReason: 'stop', jsonModeUsed: !!req.json };
    },
  };
}
