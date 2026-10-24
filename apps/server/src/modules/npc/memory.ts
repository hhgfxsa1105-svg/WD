import { randomUUID } from 'node:crypto';
import type { LogRecord, Realm } from '@jhz/contracts';
import { MEMORY_EVENTS, NPC_DEFS, applyRelationDelta, isNpcId, memorySummary, type MemoryEventKind } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import type { GameStore, GameTx } from '../store/types.js';

const PLAYER = { type: 'player' as const, id: 'player_1' };

export interface MemoryEntry {
  npcId: string;
  kind: MemoryEventKind;
  realmTo?: Realm;
}

/**
 * 把一次已记录的事件写进相关 NPC 的记忆，并按规则调整他们对玩家的看法。
 * 摘要由模板生成，关系变化由规则表给出，AI 无从插手；记忆引用的是 sourceEventId（必须已落库）。
 * 记忆与关系的变化记在**单独的后果事件**（npc.memory）里，使每个审计事件的前后差异恰好覆盖它自己造成的变化。
 */
export function recordNpcMemories(tx: GameTx, args: { sourceEventId: string; actionId: string | null; at: number; entries: MemoryEntry[] }): void {
  if (args.entries.length === 0) return;
  const before = snapshot(tx);
  for (const e of args.entries) {
    if (!isNpcId(e.npcId)) throw new AppError('NOT_FOUND', '没有这个人物');
    const def = MEMORY_EVENTS[e.kind];
    tx.addMemory({
      npcId: e.npcId,
      eventId: args.sourceEventId,
      type: e.kind,
      summary: memorySummary(e.kind, { npcName: NPC_DEFS[e.npcId].name, realmTo: e.realmTo }),
      importance: def.importance,
      at: args.at,
    });
    tx.adjustRelationship(e.npcId, PLAYER, def.relation);
  }
  const diff = stateDiff(before, snapshot(tx));
  tx.appendEvent({ actionId: args.actionId, eventType: 'npc.memory', before: diff?.before ?? null, after: diff?.after ?? null, at: args.at, log: null });
}

/** 突破的见证者：与玩家在同一地点、状态正常的 NPC */
export function breakthroughWitnesses(tx: GameTx, outcome: 'success' | 'failure', realmTo: Realm): MemoryEntry[] {
  const here = tx.player().location.id;
  return tx
    .npcs()
    .filter((n) => n.locationId === here && n.status === 'active')
    .map((n) => ({ npcId: n.id, kind: outcome === 'success' ? ('breakthrough_success' as const) : ('breakthrough_failure' as const), realmTo }));
}

export type MeetResult = { firstMeeting: false } | { firstMeeting: true; log: LogRecord; narrative: string };

/**
 * 玩家与在场的 NPC 打招呼。第一次会留下「初次相识」的记忆并微调关系（写审计事件与玩家日志）；
 * 之后再打招呼不改变任何状态。「已相识」由记忆本身判定（初次相识的重要性高于合并线，不会被合并掉），
 * 所以同一次打招呼重复提交也不会重复生效。
 */
export function meetNpc(store: GameStore, npcId: string, at: number): MeetResult {
  if (!isNpcId(npcId)) throw new AppError('NOT_FOUND', '没有这个人物');
  return store.transact((tx) => {
    const npc = tx.npcs().find((n) => n.id === npcId);
    if (!npc || npc.locationId !== tx.player().location.id) throw new AppError('PRECONDITION_FAILED', '这个人不在这里');
    if (tx.memories(npcId).some((m) => m.type === 'met')) return { firstMeeting: false };

    const d = NPC_DEFS[npcId];
    const narrative = `你走到${d.name}（${d.role}）面前，拱手见礼，两人就此相识。`;
    const eventId = randomUUID();
    const log = tx.appendEvent({
      id: eventId,
      actionId: null,
      eventType: 'npc.met',
      before: null,
      after: null,
      at,
      log: { type: 'system', narrative, changes: [], breakthrough: null, idle: null, note: null },
    });
    recordNpcMemories(tx, { sourceEventId: eventId, actionId: null, at, entries: [{ npcId, kind: 'met' }] });
    return { firstMeeting: true, log: log!, narrative };
  });
}

/** 供测试与调试：某关系按事件应得的新数值（不写库） */
export const previewRelation = (cur: { affinity: number; trust: number; hostility: number }, kind: MemoryEventKind) => applyRelationDelta(cur, MEMORY_EVENTS[kind].relation);
