import { createHash, randomUUID } from 'node:crypto';
import {
  ActionResponseSchema,
  type AiActionPlan,
  type ActionResponse,
  REALM_LABELS,
  type PlayerState,
  type SubmitActionRequest,
} from '@jhz/contracts';
import { checkPlanTarget, parseAiPlan, pillGradeOf } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { AiError, type AiGateway } from '../ai/index.js';
import { buildParseMessages, sanitizePlayerInput } from '../ai/prompt.js';
import type { CultivationService } from '../cultivation/service.js';
import type { Narrator } from '../narrative/service.js';
import type { GameStore, GameTx } from '../store/types.js';
import type { ActionService } from './service.js';

type FreeReq = Extract<SubmitActionRequest, { kind: 'free' }>;
type AiInfo = NonNullable<ActionResponse['ai']>;

/** 给玩家看的 AI 不可用提示；原始错误细节只留在服务端记录里 */
export function friendlyAiMessage(kind: AiError['kind']): string {
  switch (kind) {
    case 'DISABLED':
      return 'AI 功能未开启，请使用固定选项。';
    case 'BUDGET_EXCEEDED':
      return '今天的 AI 次数用完了，请使用固定选项，明天再来。';
    case 'INPUT_TOO_LARGE':
      return '这句话太长了，请精简后再试。';
    case 'AUTH':
    case 'BAD_REQUEST':
      return 'AI 服务的设置有问题，请检查配置，或使用固定选项。';
    default:
      return 'AI 暂时无法响应，请稍后再试，或使用固定选项。';
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** 查看状态的文字摘要（服务端模板，不经过 AI） */
export function statusText(p: PlayerState): string {
  const neili = p.neili ? `，内力 ${p.neili.current}/${p.neili.max}` : '';
  const { yuanbao, silver, copper } = p.currency;
  return `你如今是${REALM_LABELS[p.realm]}境界，修炼进度 ${p.realmProgress}%；气血 ${p.hp}/${p.maxHp}，体力 ${p.stamina}/${p.maxStamina}${neili}；身上有元宝 ${yuanbao}、银两 ${silver}、铜钱 ${copper}。`;
}

export interface FreeDeps {
  store: GameStore;
  actions: ActionService;
  cultivation: CultivationService;
  ai: AiGateway;
  /** 叙事与结算分离：结算提交后才尝试 AI 叙事；未提供则不叙事 */
  narrator?: Narrator;
}

/**
 * 自由行动：玩家原话 → AI 解析成「意图」→ 服务端校验目标 → 映射到已有的固定行动 / 突破 / 放置修炼，
 * 由服务端按**当前状态**重新判定（体力、进度、冷却、库存……），AI 无法绕过任何规则。
 * 复用固定行动的事务、幂等、审计与日志；幂等重放不会再次调用 AI。
 */
export function createFreeActionService({ store, actions, cultivation, ai, narrator }: FreeDeps) {
  /** 同一幂等键的并发请求合并为一次 AI 调用 */
  const inflight = new Map<string, Promise<ActionResponse>>();

  const respond = (player: PlayerState, narrative: string, info: AiInfo, changes: ActionResponse['changes'] = [], log: ActionResponse['log'] = null): ActionResponse =>
    ActionResponseSchema.parse({ actionId: randomUUID(), status: 'COMPLETED', narrative, changes, breakthrough: null, log, ai: info, player });

  /** 新结算的行动提交后尝试 AI 叙事；重放不叙事 */
  const settle = async ({ response, fresh }: { response: ActionResponse; fresh: boolean }): Promise<ActionResponse> =>
    fresh && narrator ? narrator.complete(response) : response;

  /** 向模型要方案；格式不合格时最多重试 1 次。返回 null 表示模型两次都没给出可用方案 */
  async function askModel(input: string): Promise<AiActionPlan | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.complete({ messages: buildParseMessages(input, { retry: attempt > 0 }), purpose: 'parse', json: true, temperature: 0 });
        const parsed = parseAiPlan(res.text, { fallbackIntent: input });
        if (parsed.ok) return parsed.plan;
      } catch (e) {
        // 模型拒答或返回空内容：当作没看懂，不再重试；其余（未开启、额度、超时、鉴权……）向上抛出
        if (e instanceof AiError && (e.kind === 'REFUSED' || e.kind === 'BAD_RESPONSE')) return null;
        throw e;
      }
    }
    return null;
  }

  async function run(req: FreeReq, fingerprint: string): Promise<ActionResponse> {
    const input = sanitizePlayerInput(req.input);
    if (!input) throw new AppError('VALIDATION_FAILED', '请输入你想做的事');

    let plan: AiActionPlan | null;
    try {
      plan = await askModel(input);
    } catch (e) {
      const kind = e instanceof AiError ? e.kind : 'BAD_RESPONSE';
      throw new AppError('AI_UNAVAILABLE', friendlyAiMessage(kind));
    }
    const player = () => store.read((tx) => tx.player());
    const clarify = (text: string, intent = input, actionType: AiActionPlan['action_type'] = 'other') =>
      respond(player(), text, { intent: intent.slice(0, 200), actionType, executed: false, clarification: text });

    if (!plan) return clarify('没太明白你想做什么，可以换个说法，比如「修炼」「休息」或「突破」。');
    if (plan.needs_clarification) return clarify(plan.clarification ?? '可以说得更具体些吗？', plan.intent, plan.action_type);
    const target = checkPlanTarget(plan);
    if (!target.ok) return clarify(target.clarification, plan.intent, plan.action_type);

    const info = (executed: boolean): AiInfo => ({ intent: plan!.intent, actionType: plan!.action_type, executed, clarification: null });

    switch (plan.action_type) {
      case 'check_status': {
        const p = player();
        return respond(p, statusText(p), info(true));
      }
      case 'start_idle':
      case 'stop_idle': {
        const r = plan.action_type === 'start_idle' ? cultivation.start() : cultivation.stop();
        const narrative = plan.action_type === 'start_idle' ? (r.job ? '你盘膝坐定，开始了放置修炼。' : '你现在无法开始放置修炼。') : '你收功起身，停止了放置修炼。';
        return respond(r.player, narrative, info(true), r.changes, r.log);
      }
      case 'cultivate':
      case 'rest': {
        const base = { kind: 'fixed' as const, idempotencyKey: req.idempotencyKey, actionId: plan.action_type };
        return settle(actions.executeFresh(base, { fingerprint, ai: info(true), eventType: `action.free.${plan.action_type}` }));
      }
      case 'breakthrough': {
        const pill = plan.target?.id ?? null;
        const base = { kind: 'breakthrough' as const, idempotencyKey: req.idempotencyKey, pillItemId: pill };
        const preCheck = (tx: GameTx) => {
          if (pill && (tx.inventory().find((i) => i.itemId === pill)?.quantity ?? 0) < 1) {
            throw new AppError('PRECONDITION_FAILED', '你的背包里没有这枚丹药');
          }
          if (pill && !pillGradeOf(pill)) throw new AppError('PRECONDITION_FAILED', '这个东西不能用来突破');
        };
        return settle(actions.executeFresh(base, { fingerprint, ai: info(true), eventType: 'action.free.breakthrough', preCheck }));
      }
      default:
        // talk / other：目前没有可交谈的对象或无法归类
        return clarify(plan.clarification ?? '这里暂时没有可以交谈的人。', plan.intent, plan.action_type);
    }
  }

  async function submit(req: FreeReq): Promise<ActionResponse> {
    const fingerprint = `free:${digest(sanitizePlayerInput(req.input))}`;
    // 幂等：已有记录就直接回放，**不再调用 AI**；同键异输入返回 409
    const replay = actions.findReplay(req.idempotencyKey, fingerprint);
    if (replay) return replay;

    const flightKey = `${req.idempotencyKey}|${fingerprint}`;
    const existing = inflight.get(flightKey);
    if (existing) return existing; // 并发的相同请求共用一次 AI 调用与一次结算
    const p = run(req, fingerprint).finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
    return p;
  }

  return { submit };
}

export type FreeActionService = ReturnType<typeof createFreeActionService>;
