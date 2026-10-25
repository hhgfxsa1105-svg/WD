import type { RelationExplainResponse } from '@jhz/contracts';
import { INITIAL_RELATIONS, type RelationTargetType } from '@jhz/game-rules';
import type { GameTx } from '../store/types.js';

const ZERO = { affinity: 0, trust: 0, hostility: 0 };

/** 事件类型 → 人能读懂的原因 */
export function causeLabel(eventType: string): string {
  if (eventType === 'npc.met') return '初次相识';
  if (eventType === 'action.breakthrough' || eventType === 'action.free.breakthrough') return '目睹你突破';
  if (eventType === 'action.quest.claim') return '任务奖励的反应';
  if (eventType === 'save.state' || eventType === 'save.import') return '导入存档';
  return eventType;
}

const same = (a: typeof ZERO, b: typeof ZERO) => a.affinity === b.affinity && a.trust === b.trust && a.hostility === b.hostility;

/**
 * 解释某条关系的数值是怎么来的：初始值 + 审计事件里记录的每一次变化 = 当前值。
 * 自检：第一次变化的前值等于初始值，每次的前值等于上一次的后值，最后一次的后值等于当前值；
 * 任何一环对不上，consistent 为 false（说明有未被审计的改动，这本身就是需要调查的问题）。
 */
export function explainRelation(tx: GameTx, npcId: string, target: { type: RelationTargetType; id: string }): RelationExplainResponse {
  const seed = INITIAL_RELATIONS.find((r) => r.npcId === npcId && r.targetType === target.type && r.targetId === target.id);
  const initial = seed ? { affinity: seed.affinity, trust: seed.trust, hostility: seed.hostility } : ZERO;
  const cur = tx.relationships().find((r) => r.npcId === npcId && r.targetType === target.type && r.targetId === target.id);
  const current = cur ? { affinity: cur.affinity, trust: cur.trust, hostility: cur.hostility } : ZERO;

  let prev = initial;
  let consistent = true;
  const changes = tx.relationHistory(npcId, target).map((h) => {
    const before = h.before ?? ZERO;
    if (!same(before, prev)) consistent = false;
    prev = h.after;
    return {
      seq: h.seq,
      eventId: h.eventId,
      at: h.at,
      eventType: h.eventType,
      cause: causeLabel(h.causeType),
      delta: { affinity: h.after.affinity - before.affinity, trust: h.after.trust - before.trust, hostility: h.after.hostility - before.hostility },
      after: h.after,
    };
  });
  if (!same(prev, current)) consistent = false;
  return { npcId, target, initial, current, changes, consistent };
}
