import { randomUUID } from 'node:crypto';
import {
  ActionResponseSchema,
  PersonalListResponseSchema,
  PersonalResolveResponseSchema,
  REALM_LABELS,
  type ActionResponse,
  type PersonalEventRecord,
  type PersonalListResponse,
  type PersonalProposal,
  type PersonalResolveResponse,
  type StateChange,
} from '@jhz/contracts';
import {
  DIFFICULTY_LABEL,
  FACTION_DEFS,
  LOCATION_DEFS,
  NPC_DEFS,
  isFactionId,
  isNpcId,
  PERSONAL_TIER_COST,
  TIER_LABEL,
  gameDate,
  isLocationId,
  neighborsOf,
  parsePersonalProposal,
  personalChance,
  personalSucceeds,
  strengthLabel,
  attitudeLabel,
  type Rng,
} from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { friendlyAiMessage } from '../ai/friendly.js';
import { AiError, type AiGateway } from '../ai/index.js';
import { buildProposalMessages, type PersonalContext } from '../ai/personal-prompt.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import { advanceQuests } from '../quest/service.js';
import type { Clock } from '../../shared/runtime.js';
import type { GameStore, GameTx } from '../store/types.js';
import { tickWorld } from '../world-events/service.js';
import { applyPersonalEffects, expiresIn, logRumors, personalView } from './lifecycle.js';

export interface PersonalDeps {
  store: GameStore;
  ai: AiGateway;
  clock: Clock;
  rng: Rng;
}

const MIN_STAMINA = Math.min(...Object.values(PERSONAL_TIER_COST).map((c) => c.stamina));

const busyMessage = (rec: PersonalEventRecord) => `你正忙着「${rec.proposal.title}」，先进行或放弃它再说`;

/** 服务端构造的世界摘要：AI 只看得到这个，看不到玩家原话 */
export function buildContext(tx: GameTx, intent: string): PersonalContext {
  const p = tx.player();
  const here = p.location.id;
  const states = new Map(tx.locations().map((l) => [l.id, l.status]));
  return {
    intent,
    time: gameDate(tx.gameMinutes()).label,
    location: { id: here, name: p.location.name },
    player: { realm: REALM_LABELS[p.realm], attributes: { ...p.attributes }, staminaEnough: p.stamina >= MIN_STAMINA },
    npcsHere: tx
      .npcs()
      .filter((n) => n.locationId === here && n.status !== 'away')
      .map((n) => ({ id: n.id, name: npcLabel(n.id), role: npcRole(n.id) })),
    exits: neighborsOf(here).map((id) => ({ id, name: isLocationId(id) ? LOCATION_DEFS[id].name : id, blocked: states.get(id) === 'blocked' })),
    factions: tx.factions().map((f) => ({ id: f.id, name: facLabel(f.id), strength: strengthLabel(f.strength), attitude: attitudeLabel(f.attitude) })),
  };
}

const npcLabel = (id: string) => (isNpcId(id) ? NPC_DEFS[id].name : id);
const npcRole = (id: string) => (isNpcId(id) ? NPC_DEFS[id].role : '');
const facLabel = (id: string) => (isFactionId(id) ? FACTION_DEFS[id].name : id);

const proposalText = (p: PersonalProposal, chance: number) => {
  const c = PERSONAL_TIER_COST[p.tier];
  return `${p.intro}（${TIER_LABEL[p.tier]} · ${DIFFICULTY_LABEL[p.difficulty]} · 约 ${c.minutes} 分钟、体力 ${c.stamina} · 成功率约 ${chance}%）可以「进行」或「放弃」。`;
};

/**
 * 个人轨：玩家自定义行为（预设之外）→ AI 提议个人事件 → 玩家选择进行或放弃 → 服务端判定成败。
 * AI 只看到服务端构造的结构化摘要；提议必须通过严格校验（白名单效果、无数值、无系统口吻）；
 * 耗时 / 体力 / 成功率 / 掷点 / 效果的应用全部由服务端规则决定。
 */
export function createPersonalService({ store, ai, clock, rng }: PersonalDeps) {
  /** 向模型要提议；格式或内容不合格时最多重试 1 次。null = 两次都没给出可用提议 */
  async function askModel(ctx: PersonalContext): Promise<PersonalProposal | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.complete({ messages: buildProposalMessages(ctx, { retry: attempt > 0 }), purpose: 'parse', json: true, temperature: 0.7 });
        const parsed = parsePersonalProposal(res.text);
        if (parsed.ok) return parsed.proposal;
      } catch (e) {
        if (e instanceof AiError && (e.kind === 'REFUSED' || e.kind === 'BAD_RESPONSE')) return null;
        throw e;
      }
    }
    return null;
  }

  /** 同一幂等键已提议过：返回同一个事件（不再调用 AI）；指纹不同 409；没有返回 null */
  function replay(idempotencyKey: string, fingerprint: string): ActionResponse | null {
    return store.read((tx) => {
      const rec = tx.findPersonalByKey(idempotencyKey);
      if (!rec) return null;
      if (rec.fingerprint !== fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
      return ActionResponseSchema.parse({
        actionId: rec.id,
        status: 'COMPLETED',
        narrative: proposalText(rec.proposal, rec.chancePercent),
        changes: [],
        breakthrough: null,
        log: null,
        ai: { intent: rec.intent, actionType: 'custom', executed: true, clarification: null },
        player: tx.player(),
      });
    });
  }

  /** 前置检查（在调用 AI 之前）：正忙或体力连最小的事都做不了就直接拒绝，省一次调用 */
  function preCheck(tx: GameTx): void {
    const busy = tx.activePersonalEvent();
    if (busy) throw new AppError('PRECONDITION_FAILED', busyMessage(busy));
    if (tx.player().stamina < MIN_STAMINA) throw new AppError('PRECONDITION_FAILED', `体力不足，再小的事也要 ${MIN_STAMINA} 点体力，先休息一下`);
  }

  /** 开始一次自定义行为。返回 null 表示模型没给出可用提议（调用方按「没看懂」处理，状态不变） */
  async function propose(args: { idempotencyKey: string; fingerprint: string; intent: string }): Promise<ActionResponse | null> {
    const ctx = store.read((tx) => {
      preCheck(tx);
      return buildContext(tx, args.intent.slice(0, 80));
    });
    let proposal: PersonalProposal | null;
    try {
      proposal = await askModel(ctx);
    } catch (e) {
      throw new AppError('AI_UNAVAILABLE', friendlyAiMessage(e instanceof AiError ? e.kind : 'BAD_RESPONSE'));
    }
    if (!proposal) return null;

    const at = clock.now();
    return store.transact((tx) => {
      const seen = tx.findPersonalByKey(args.idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== args.fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
        return replay(args.idempotencyKey, args.fingerprint)!; // 并发重试：已有结果
      }
      preCheck(tx); // AI 调用期间状态可能变了
      const now = tx.gameMinutes();
      const p = tx.player();
      const chance = personalChance(proposal.difficulty, p.attributes, proposal.skill);
      const before = snapshot(tx);
      const rec = tx.createPersonalEvent({
        id: randomUUID(),
        idempotencyKey: args.idempotencyKey,
        fingerprint: args.fingerprint,
        intent: ctx.intent,
        proposal,
        createdAtMinutes: now,
        expiresAtMinutes: expiresIn(now),
        chancePercent: chance,
      });
      const diff = stateDiff(before, snapshot(tx));
      const narrative = proposalText(proposal, chance);
      const log = tx.appendEvent({
        actionId: null,
        eventType: 'personal.propose',
        before: diff?.before ?? null,
        after: diff?.after ?? null,
        at,
        log: { type: 'system', narrative: `${proposal.title}：${narrative}`, changes: [], breakthrough: null, idle: null, note: '个人事件' },
      });
      return ActionResponseSchema.parse({
        actionId: rec.id,
        status: 'COMPLETED',
        narrative,
        changes: [],
        breakthrough: null,
        log,
        ai: { intent: rec.intent, actionType: 'custom', executed: true, clarification: null },
        player: tx.player(),
      });
    });
  }

  function find(tx: GameTx, id: string): PersonalEventRecord {
    const rec = tx.personalEvents().find((e) => e.id === id);
    if (!rec) throw new AppError('NOT_FOUND', '没有这件事');
    return rec;
  }

  /** 进行：消耗体力和时间，服务端掷点判定成败，应用对应分支的效果 */
  function resolve(id: string): PersonalResolveResponse {
    const at = clock.now();
    return store.transact((tx) => {
      const rec = find(tx, id);
      if (rec.state !== 'active') throw new AppError('PRECONDITION_FAILED', '这件事已经了结');
      const cost = PERSONAL_TIER_COST[rec.proposal.tier];
      const player = tx.player();
      if (player.stamina < cost.stamina) throw new AppError('PRECONDITION_FAILED', `体力不足，这件事需要 ${cost.stamina} 点体力`);

      const before = snapshot(tx);
      const roll = Math.floor(rng() * 10000) / 100;
      const success = personalSucceeds(roll, rec.chancePercent);
      const branch = success ? rec.proposal.success : rec.proposal.failure;
      tx.savePlayer({ ...player, stamina: player.stamina - cost.stamina });
      tx.advanceGameClock(cost.minutes);
      const now = tx.gameMinutes();
      const applied = applyPersonalEffects(tx, branch.effects, now);
      tx.finishPersonalEvent(id, { state: 'resolved', outcome: success ? 'success' : 'failure', roll, resolvedAtMinutes: now, lock: applied.lock });
      const changes: StateChange[] = [{ stat: 'stamina', delta: -cost.stamina }];
      const diff = stateDiff(before, snapshot(tx));
      const log = tx.appendEvent({
        actionId: null,
        eventType: 'personal.resolve',
        before: diff?.before ?? null,
        after: diff?.after ?? null,
        at,
        log: { type: 'fixed', narrative: branch.narrative, changes, breakthrough: null, idle: null, note: success ? '事成' : '事败' },
      });
      logRumors(tx, applied.rumors, at, null);
      tickWorld(tx, { at, actionId: null });
      advanceQuests(tx, at, null);
      return PersonalResolveResponseSchema.parse({
        narrative: branch.narrative,
        outcome: success ? 'success' : 'failure',
        changes,
        player: tx.player(),
        log,
        event: personalView(find(tx, id)),
      });
    });
  }

  /** 放弃：算失败，但不发生任何效果、不耗时间和体力 */
  function abandon(id: string): PersonalResolveResponse {
    const at = clock.now();
    return store.transact((tx) => {
      const rec = find(tx, id);
      if (rec.state !== 'active') throw new AppError('PRECONDITION_FAILED', '这件事已经了结');
      const before = snapshot(tx);
      tx.finishPersonalEvent(id, { state: 'abandoned', outcome: 'failure', roll: null, resolvedAtMinutes: tx.gameMinutes(), lock: null });
      const diff = stateDiff(before, snapshot(tx));
      const narrative = `你放弃了「${rec.proposal.title}」。`;
      const log = tx.appendEvent({ actionId: null, eventType: 'personal.abandon', before: diff?.before ?? null, after: diff?.after ?? null, at, log: { type: 'system', narrative, changes: [], breakthrough: null, idle: null, note: '个人事件' } });
      return PersonalResolveResponseSchema.parse({ narrative, outcome: 'failure', changes: [], player: tx.player(), log, event: personalView(find(tx, id)) });
    });
  }

  const list = (): PersonalListResponse =>
    store.read((tx) => {
      const all = tx.personalEvents();
      const active = all.find((e) => e.state === 'active') ?? null;
      return PersonalListResponseSchema.parse({
        active: active ? personalView(active) : null,
        recent: all
          .filter((e) => e.state !== 'active')
          .slice(-5)
          .reverse()
          .map(personalView),
      });
    });

  return { replay, propose, resolve, abandon, list };
}

export type PersonalService = ReturnType<typeof createPersonalService>;
