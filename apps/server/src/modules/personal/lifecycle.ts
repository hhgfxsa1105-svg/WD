import type { PersonalEffect, PersonalEventRecord, PersonalEventView } from '@jhz/contracts';
import { PersonalEventViewSchema } from '@jhz/contracts';
import { LOCATION_DEFS, PERSONAL_EXPIRE_MINUTES, PERSONAL_LOCK_MINUTES, PERSONAL_TIER_COST, gameDate, isLocationId } from '@jhz/game-rules';
import { snapshot, stateDiff } from '../audit/diff.js';
import type { GameTx, LogPayload } from '../store/types.js';

const PLAYER = { type: 'player' as const, id: 'player_1' };
const locName = (id: string) => (isLocationId(id) ? LOCATION_DEFS[id].name : id);
const sysLog = (narrative: string, note: string): LogPayload => ({ type: 'system', narrative, changes: [], breakthrough: null, idle: null, note });

export const expiresIn = (now: number) => now + PERSONAL_EXPIRE_MINUTES;

/** 玩家看到的个人事件 */
export function personalView(rec: PersonalEventRecord): PersonalEventView {
  const cost = PERSONAL_TIER_COST[rec.proposal.tier];
  const branch = rec.outcome === 'success' ? rec.proposal.success : rec.outcome === 'failure' && rec.state === 'resolved' ? rec.proposal.failure : null;
  const result = branch ? branch.narrative : rec.state === 'abandoned' ? '你放弃了这件事。' : rec.state === 'expired' ? '你耽搁太久，机会错过了。' : null;
  return PersonalEventViewSchema.parse({
    id: rec.id,
    state: rec.state,
    title: rec.proposal.title,
    intro: rec.proposal.intro,
    tier: rec.proposal.tier,
    minutes: cost.minutes,
    staminaCost: cost.stamina,
    difficulty: rec.proposal.difficulty,
    skill: rec.proposal.skill,
    chancePercent: rec.chancePercent,
    expiresAt: { minutes: rec.expiresAtMinutes, label: gameDate(rec.expiresAtMinutes).label },
    outcome: rec.outcome,
    result,
  });
}

export interface AppliedEffects {
  /** 要登记的地点封锁（至多一个） */
  lock: PersonalEventRecord['lock'];
  /** 传闻文字，逐条成为玩家日志 */
  rumors: string[];
}

/**
 * 应用白名单效果。结构与对象存在性在解析时已检查，这里再按**当前世界状态**判定：
 * 封锁只作用于当前开放、且玩家不在其中的地点，一个事件至多登记一处封锁；其余按存档层的限幅规则应用。
 * 状态不满足的效果直接跳过（不报错、不改变任何东西）。
 */
export function applyPersonalEffects(tx: GameTx, effects: readonly PersonalEffect[], now: number): AppliedEffects {
  let lock: PersonalEventRecord['lock'] = null;
  const rumors: string[] = [];
  for (const e of effects) {
    switch (e.kind) {
      case 'npc_move':
        tx.moveNpc(e.npcId, e.locationId);
        break;
      case 'npc_status':
        tx.setNpcStatus(e.npcId, e.status);
        break;
      case 'location_block': {
        const cur = tx.locations().find((l) => l.id === e.locationId);
        if (lock || !cur || cur.status === 'blocked' || tx.player().location.id === e.locationId) break;
        tx.setLocationStatus(e.locationId, 'blocked', e.reason);
        lock = { locationId: e.locationId, reason: e.reason, untilMinutes: now + PERSONAL_LOCK_MINUTES, released: false };
        break;
      }
      case 'faction_strength':
        tx.applyFactionEffects([{ kind: 'strength', faction: e.factionId as never, delta: e.delta }]);
        break;
      case 'faction_attitude':
        tx.applyFactionEffects([{ kind: 'attitude', faction: e.factionId as never, delta: e.delta }]);
        break;
      case 'faction_relation':
        tx.applyFactionEffects([{ kind: 'relation', a: e.a as never, b: e.b as never, delta: e.delta }]);
        break;
      case 'npc_attitude':
        tx.adjustRelationship(e.npcId, PLAYER, { affinity: e.affinity, trust: e.trust, hostility: e.hostility });
        break;
      case 'rumor':
        rumors.push(e.text);
        break;
    }
  }
  return { lock, rumors };
}

/** 传闻写成玩家日志（一条传闻一个后果事件） */
export function logRumors(tx: GameTx, rumors: readonly string[], at: number, actionId: string | null): void {
  for (const text of rumors) tx.appendEvent({ actionId, eventType: 'personal.rumor', before: null, after: null, at, log: sysLog(text, '传闻') });
}

/**
 * 时间推进后的个人轨维护（由系统轨调度一并调用）：
 * ① 进行中的事件逾期未处理 → 作废，算失败；② 临时封锁到期 → 恢复开放（仅当封锁仍是这次留下的）。
 * 每一项一个后果审计事件，重复调用不会重复发生。
 */
export function maintainPersonal(tx: GameTx, opts: { at: number; actionId: string | null }): number {
  let done = 0;
  const now = tx.gameMinutes();
  const all = tx.personalEvents(); // 一次读出，下面都用它
  const active = all.find((e) => e.state === 'active') ?? null;
  if (active && now >= active.expiresAtMinutes) {
    const before = snapshot(tx);
    tx.finishPersonalEvent(active.id, { state: 'expired', outcome: 'failure', roll: null, resolvedAtMinutes: now, lock: null });
    const diff = stateDiff(before, snapshot(tx));
    tx.appendEvent({ actionId: opts.actionId, eventType: 'personal.expire', before: diff?.before ?? null, after: diff?.after ?? null, at: opts.at, log: sysLog(`你耽搁太久，「${active.proposal.title}」的机会错过了。`, '个人事件') });
    done++;
  }
  for (const rec of all) {
    if (!rec.lock || rec.lock.released || now < rec.lock.untilMinutes) continue;
    const before = snapshot(tx);
    const loc = tx.locations().find((l) => l.id === rec.lock!.locationId);
    const still = loc?.status === 'blocked' && loc.reason === rec.lock.reason;
    if (still) tx.setLocationStatus(rec.lock.locationId, 'open', null);
    tx.releasePersonalLock(rec.id);
    const diff = stateDiff(before, snapshot(tx));
    tx.appendEvent({ actionId: opts.actionId, eventType: 'personal.lock.release', before: diff?.before ?? null, after: diff?.after ?? null, at: opts.at, log: still ? sysLog(`${locName(rec.lock.locationId)}重新开放了。`, '个人事件') : null });
    done++;
  }
  return done;
}
