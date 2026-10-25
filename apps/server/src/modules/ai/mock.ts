import { LOCATION_DEFS, NPC_DEFS } from '@jhz/game-rules';
import { PROPOSAL_MARKER } from './personal-prompt.js';
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

/** 文字里提到的地点（按名字或常用叫法） */
const PLACE_ALIASES: Record<string, RegExp> = { loc_qingyun_gate: /山门/, loc_qingyun_yard: /练功场|演武场/, loc_qingyun_hall: /大殿/, loc_qingyun_library: /藏经阁|书阁/, loc_foot_path: /山道/, loc_foot_town: /小镇|镇上/ };
const placeOf = (text: string): keyof typeof LOCATION_DEFS | null => (Object.entries(PLACE_ALIASES).find(([, re]) => re.test(text))?.[0] as keyof typeof LOCATION_DEFS | undefined) ?? null;

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
      if (req.messages[0]?.content.includes(PROPOSAL_MARKER)) out = mockProposal(text);
      else if (req.purpose === 'narrate') out = '你定了定神，按自己的意思行事，一切顺理成章。';
      else if (/突破|冲关|破境|冲击/.test(text)) {
        const pill = /丹/.test(text) && !/不(用|吃|使用)/.test(text);
        out = plan('breakthrough', { intent: '尝试突破', target: pill ? { type: 'item', id: 'pill_breakthrough_fan' } : null });
      } else if (/(停止|结束).*(修炼|挂机)|不.*(修炼|挂机)了/.test(text)) out = plan('stop_idle', { intent: '停止放置修炼' });
      else if (/挂机|放置|(开始|继续).*修炼/.test(text)) out = plan('start_idle', { intent: '开始放置修炼' });
      else if (/去|前往|走到|到达|赶往|回到|上山|下山/.test(text) && placeOf(text)) {
        out = plan('travel', { intent: '前往' + LOCATION_DEFS[placeOf(text)!].name, target: { type: 'location', id: placeOf(text) } });
      } else if (/打听|打探|摆摊|帮忙|帮厨|巡逻|巡视|切磋|跟踪|采药|砍柴/.test(text)) out = plan('custom', { intent: text.slice(0, 40) });
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

/** 模拟的个人事件提议：按摘要里在场的人给出一个小事件（只用白名单效果） */
function mockProposal(userJson: string): string {
  let ctx: { npcsHere?: { id: string; name: string }[]; intent?: string } = {};
  try {
    ctx = JSON.parse(userJson);
  } catch {
    /* 摘要损坏时给最保守的提议 */
  }
  const npc = ctx.npcsHere?.[0];
  return JSON.stringify(
    npc
      ? {
          title: `向${npc.name}打听消息`,
          intro: `你凑到${npc.name}身边，不动声色地聊起了近来的见闻。`,
          tier: 'small',
          difficulty: 'easy',
          skill: 'comprehension',
          success: { narrative: `${npc.name}见你诚恳，把近来听到的风声说了不少。`, effects: [{ kind: 'npc_attitude', npcId: npc.id, affinity: 2 }, { kind: 'rumor', text: `听${npc.name}说，山下最近不太平` }] },
          failure: { narrative: `${npc.name}警觉地看了你一眼，什么也没说。`, effects: [] },
        }
      : {
          title: '四处走动打听',
          intro: '你在附近转了转，留心听着往来行人的闲谈。',
          tier: 'small',
          difficulty: 'normal',
          skill: 'comprehension',
          success: { narrative: '你从几句闲谈里拼凑出了一点有用的风声。', effects: [{ kind: 'rumor', text: '听路人说，近来山下有生面孔出没' }] },
          failure: { narrative: '转了一圈，没听到什么值得记下的。', effects: [] },
        },
  );
}
