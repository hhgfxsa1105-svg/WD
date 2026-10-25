import type { QuestView, StateChange } from '@jhz/contracts';
import { ITEM_DEFS, QUEST_DEFS, advanceSteps, isQuestId, rewardLines, type QuestDef, type QuestFacts, type QuestId } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import type { GameTx, LogPayload } from '../store/types.js';

const PLAYER = { type: 'player' as const, id: 'player_1' };
const itemName = (id: string) => ITEM_DEFS[id]?.name ?? id;

/** 判定任务条件所需的事实：全部来自已保存状态；「已相识」按需查询该 NPC 的记忆 */
export function questFacts(tx: GameTx): QuestFacts {
  const p = tx.player();
  const met = new Map<string, boolean>();
  return {
    player: { location: p.location, realmProgress: p.realmProgress, realm: p.realm },
    metNpcs: {
      has(npcId) {
        if (!met.has(npcId)) met.set(npcId, tx.memories(npcId).some((m) => m.type === 'met'));
        return met.get(npcId)!;
      },
    },
  };
}

const systemLog = (narrative: string, changes: StateChange[] = [], note: string | null = null): LogPayload => ({ type: 'system', narrative, changes, breakthrough: null, idle: null, note });

/**
 * 评估所有进行中的任务：满足条件的步骤依次推进；全部完成则任务进入 completed 并解锁后续任务。
 * 在任何可能改变相关事实的事务末尾调用（行动、见面、放置修炼结算……）。有变化时写一个 quest.progress 审计事件
 * （差异恰好覆盖任务状态的变化）与一条玩家日志；没有变化则什么都不写。
 */
export function advanceQuests(tx: GameTx, at: number, actionId: string | null): void {
  const active = tx.quests().filter((q) => q.status === 'active');
  if (active.length === 0) return;
  const before = snapshot(tx);
  const facts = questFacts(tx);
  const lines: string[] = [];
  for (const q of active) {
    if (!isQuestId(q.id)) continue;
    const def = QUEST_DEFS[q.id];
    const idx = advanceSteps(def, q.stepIndex, facts);
    if (idx === q.stepIndex) continue;
    tx.updateQuest(q.id, { stepIndex: idx }, at);
    for (let i = q.stepIndex; i < idx; i++) lines.push(`任务「${def.name}」：${def.steps[i]!.text} ✓`);
    if (idx === def.steps.length) {
      tx.updateQuest(q.id, { status: 'completed' }, at);
      lines.push(`任务「${def.name}」的条件都满足了，可以领取奖励。`);
      for (const [otherId, other] of Object.entries(QUEST_DEFS)) {
        if (other.requires === q.id && tx.quests().find((x) => x.id === otherId)?.status === 'locked') {
          tx.updateQuest(otherId, { status: 'available' }, at);
          lines.push(`新任务「${other.name}」可以接取了。`);
        }
      }
    }
  }
  if (lines.length === 0) return;
  const diff = stateDiff(before, snapshot(tx));
  tx.appendEvent({ actionId, eventType: 'quest.progress', before: diff?.before ?? null, after: diff?.after ?? null, at, log: systemLog(lines.join('\n')) });
}

export interface QuestOpResult {
  changes: StateChange[];
  narrative: string;
  log: LogPayload;
}

const STATUS_HINT: Record<string, string> = {
  active: '这个任务已经接取了',
  completed: '这个任务已经完成了',
  failed: '这个任务已经失败，不能再接取',
};

/** 执行一次任务操作（在行动事务内，状态与奖励一并提交或回滚）；不合法抛 PRECONDITION_FAILED / NOT_FOUND */
export function resolveQuestOp(tx: GameTx, req: { questId: string; op: 'accept' | 'claim' | 'abandon' }, at: number): QuestOpResult {
  if (!isQuestId(req.questId)) throw new AppError('NOT_FOUND', '没有这个任务');
  const id: QuestId = req.questId;
  const def: QuestDef = QUEST_DEFS[id];
  const q = tx.quests().find((x) => x.id === id);
  if (!q) throw new AppError('NOT_FOUND', '没有这个任务');

  if (req.op === 'accept') {
    if (q.status === 'locked') {
      const need = def.requires && isQuestId(def.requires) ? QUEST_DEFS[def.requires].name : '前置任务';
      throw new AppError('PRECONDITION_FAILED', `任务还没有解锁，需要先完成「${need}」`);
    }
    if (q.status !== 'available') throw new AppError('PRECONDITION_FAILED', STATUS_HINT[q.status] ?? '现在不能接取这个任务');
    tx.updateQuest(id, { status: 'active' }, at);
    const narrative = `你接下了任务「${def.name}」。${def.summary}`;
    return { changes: [], narrative, log: systemLog(narrative) };
  }

  if (req.op === 'abandon') {
    if (q.status !== 'active') throw new AppError('PRECONDITION_FAILED', '只有进行中的任务可以放弃');
    tx.updateQuest(id, { status: 'failed' }, at);
    const narrative = `你放弃了任务「${def.name}」。`;
    return { changes: [], narrative, log: systemLog(narrative) };
  }

  // claim：只能领取一次（markQuestClaimed 在已领取/未完成时拒绝），奖励与领取标记在同一事务里
  tx.markQuestClaimed(id, at);
  const player = tx.player();
  const c = def.reward.currency ?? {};
  const currency = { yuanbao: player.currency.yuanbao + (c.yuanbao ?? 0), silver: player.currency.silver + (c.silver ?? 0), copper: player.currency.copper + (c.copper ?? 0) };
  tx.savePlayer({ ...player, currency });
  for (const it of def.reward.items ?? []) tx.addItem(it.itemId, it.quantity);
  const changes: StateChange[] = (['yuanbao', 'silver', 'copper'] as const).flatMap((k) => ((c[k] ?? 0) > 0 ? [{ stat: k, delta: c[k]! }] : []));
  const r = def.reaction;
  if (r) tx.adjustRelationship(r.npcId, PLAYER, r.relation);
  const got = rewardLines(def.reward, itemName).join('、');
  const narrative = `任务「${def.name}」完成，获得：${got}。`;
  return { changes, narrative, log: systemLog(narrative, changes, r?.text ?? null) };
}

/** 任务列表视图：静态文字 + 当前状态 */
export function questViews(tx: GameTx): QuestView[] {
  return tx.quests().flatMap((q) => {
    if (!isQuestId(q.id)) return [];
    const def: QuestDef = QUEST_DEFS[q.id];
    const lockedBy = q.status === 'locked' && def.requires && isQuestId(def.requires) ? QUEST_DEFS[def.requires].name : null;
    return [
      {
        id: q.id,
        name: def.name,
        summary: def.summary,
        giver: def.giver,
        status: q.status,
        steps: def.steps.map((s, i) => ({ text: s.text, done: i < q.stepIndex })),
        reward: rewardLines(def.reward, itemName),
        claimed: q.claimed,
        lockedBy,
      },
    ];
  });
}
