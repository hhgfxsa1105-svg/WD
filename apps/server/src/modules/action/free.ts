import { createHash, randomUUID } from 'node:crypto';
import {
  ActionResponseSchema,
  type AiActionPlan,
  type ActionResponse,
  REALM_LABELS,
  type PlayerState,
  type SubmitActionRequest,
} from '@jhz/contracts';
import { NPC_DEFS, checkPlanTarget, isNpcId, locationName, parseAiPlan, pillGradeOf } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { AiError, type AiGateway } from '../ai/index.js';
import { friendlyAiMessage } from '../ai/friendly.js';
import { buildParseMessages, sanitizePlayerInput } from '../ai/prompt.js';
import type { CultivationService } from '../cultivation/service.js';
import { meetNpc } from '../npc/memory.js';
import type { Clock } from '../../shared/runtime.js';
import type { Narrator } from '../narrative/service.js';
import type { GameStore, GameTx } from '../store/types.js';
import type { PersonalService } from '../personal/service.js';
import type { ActionService } from './service.js';

type FreeReq = Extract<SubmitActionRequest, { kind: 'free' }>;
type AiInfo = NonNullable<ActionResponse['ai']>;

export { friendlyAiMessage } from '../ai/friendly.js';

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** 查看状态的文字摘要（服务端模板，不经过 AI） */
export function statusText(p: PlayerState): string {
  const neili = p.neili ? `，内力 ${p.neili.current}/${p.neili.max}` : '';
  const { yuanbao, silver, copper } = p.currency;
  return `你如今是${REALM_LABELS[p.realm]}境界，修炼进度 ${p.realmProgress}%；气血 ${p.hp}/${p.maxHp}，体力 ${p.stamina}/${p.maxStamina}${neili}；身上有元宝 ${yuanbao}、银两 ${silver}、铜钱 ${copper}。`;
}

/** 与人交谈：目前只做存在性与位置判定，不改变任何状态；真正的对话随 NPC 记忆一起开放 */
export function talkText(player: PlayerState, npcs: { id: string; locationId: string }[], targetId: string | null): string {
  const here = npcs.filter((n) => n.locationId === player.location.id && isNpcId(n.id));
  const label = (id: string) => (isNpcId(id) ? `${NPC_DEFS[id].name}（${NPC_DEFS[id].role}）` : id);
  if (targetId && isNpcId(targetId)) {
    const npc = npcs.find((n) => n.id === targetId);
    if (!npc || npc.locationId !== player.location.id) {
      const where = npc ? locationName(npc.locationId) : null;
      return `${NPC_DEFS[targetId].name}${where ? `现在在${where}` : '不在这里'}，你得先找过去。`;
    }
    return `你走到${label(targetId)}面前，拱手见礼。对方点了点头——更多的话，要等对话功能开放后才能说了。`;
  }
  return here.length > 0 ? `你想和谁说话？这里有：${here.map((n) => label(n.id)).join('、')}。` : '这里没有可以交谈的人。';
}

export interface FreeDeps {
  store: GameStore;
  actions: ActionService;
  cultivation: CultivationService;
  ai: AiGateway;
  clock: Clock;
  /** 叙事与结算分离：结算提交后才尝试 AI 叙事；未提供则不叙事 */
  narrator?: Narrator;
  /** 个人轨：自定义行为 → AI 提议个人事件 */
  personal?: PersonalService;
}

/**
 * 自由行动：玩家原话 → AI 解析成「意图」→ 服务端校验目标 → 映射到已有的固定行动 / 突破 / 放置修炼，
 * 由服务端按**当前状态**重新判定（体力、进度、冷却、库存……），AI 无法绕过任何规则。
 * 复用固定行动的事务、幂等、审计与日志；幂等重放不会再次调用 AI。
 */
export function createFreeActionService({ store, actions, cultivation, ai, clock, narrator, personal }: FreeDeps) {
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
      case 'travel': {
        // 目标已通过目录校验是地点；相邻与体力由服务端按当前状态判定（与点地图走同一条结算管线）
        const base = { kind: 'move' as const, idempotencyKey: req.idempotencyKey, locationId: plan.target!.id };
        return settle(actions.executeFresh(base, { fingerprint, ai: info(true), eventType: 'action.free.travel' }));
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
      case 'custom': {
        // 预设之外的自定义行为：进入个人轨。AI 只能提议个人事件，成败由服务端判定；这里先开出事件，玩家再选「进行」或「放弃」
        if (!personal) return clarify('这类行为暂时还不能做，请使用固定选项。', plan.intent, plan.action_type);
        const proposed = await personal.propose({ idempotencyKey: req.idempotencyKey, fingerprint, intent: plan.intent });
        return proposed ?? clarify('这件事一时想不出怎么展开，换个说法试试？', plan.intent, plan.action_type);
      }
      default:
        if (plan.action_type === 'talk') {
          const targetId = plan.target?.type === 'npc' ? plan.target.id : null;
          const here = targetId ? store.read((tx) => tx.npcs().find((n) => n.id === targetId)?.locationId === tx.player().location.id) : false;
          if (targetId && here) {
            // 在场：第一次见面会留下记忆并微调关系（有审计事件与日志）；之后再打招呼不改状态
            const met = meetNpc(store, targetId, clock.now());
            if (met.firstMeeting) return respond(player(), met.narrative, info(true), [], met.log);
          }
          return clarify(talkText(player(), store.read((tx) => tx.npcs()), targetId), plan.intent, plan.action_type);
        }
        return clarify(plan.clarification ?? '没太明白你想做什么，可以换个说法。', plan.intent, plan.action_type);
    }
  }

  async function submit(req: FreeReq): Promise<ActionResponse> {
    const fingerprint = `free:${digest(sanitizePlayerInput(req.input))}`;
    // 幂等：已有记录就直接回放，**不再调用 AI**；同键异输入返回 409
    const replay = actions.findReplay(req.idempotencyKey, fingerprint) ?? personal?.replay(req.idempotencyKey, fingerprint) ?? null;
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
