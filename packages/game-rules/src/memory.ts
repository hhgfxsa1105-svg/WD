import { MEMORY_LIMITS, REALM_LABELS, type MemoryType, type NpcMemory, type Realm } from '@jhz/contracts';
import type { RelationDelta } from './world.js';

/**
 * NPC 记忆规则：什么事件会被记住、记多重要、摘要怎么写、旧记忆怎么合并、对话时取哪些。
 * 摘要一律由模板生成，AI 无法往记忆里写入任何文字，所以记忆里只有真实发生过的事实。
 */

export type MemoryEventKind = Exclude<MemoryType, 'summary'>;

export interface MemoryEventDef {
  importance: number;
  /** 这件事对 NPC 看法的影响（经 applyRelationDelta 限幅） */
  relation: RelationDelta;
}

export const MEMORY_EVENTS: Record<MemoryEventKind, MemoryEventDef> = {
  /** 初次相识的重要性高于合并线：永不被合并，因此「是否已相识」可以由记忆本身判定 */
  met: { importance: 6, relation: { affinity: 3, trust: 2 } },
  breakthrough_success: { importance: 6, relation: { affinity: 3, trust: 1 } },
  breakthrough_failure: { importance: 3, relation: { affinity: 1 } },
};

/** 每个 NPC 保留的记忆条数上限；超过时把旧的低重要性记忆合并为摘要 */
export const MEMORY_CAP = 30;
/** 重要性不高于此值的记忆才可能被合并；更重要的记忆永不合并、永不删除 */
export const MEMORY_MERGE_MAX_IMPORTANCE = 5;
/** 一次合并最多吞并的记忆条数 */
export const MEMORY_MERGE_BATCH = 8;

const LABEL: Record<MemoryEventKind, string> = { met: '初次相识', breakthrough_success: '目睹你突破', breakthrough_failure: '目睹你突破失败' };

export interface MemoryContext {
  npcName: string;
  /** 突破成功后的境界 */
  realmTo?: Realm;
}

/** 事件 → 记忆摘要（模板，≤ MEMORY_LIMITS.summaryMax 字） */
export function memorySummary(kind: MemoryEventKind, ctx: MemoryContext): string {
  switch (kind) {
    case 'met':
      return `你与${ctx.npcName}初次相识。`;
    case 'breakthrough_success':
      return `${ctx.npcName}亲眼见你突破至${ctx.realmTo ? REALM_LABELS[ctx.realmTo] : '新的境界'}。`;
    case 'breakthrough_failure':
      return `${ctx.npcName}看见你突破失败，没有多说什么。`;
  }
}

type Mem = Pick<NpcMemory, 'id' | 'type' | 'importance' | 'sourceCount' | 'createdAt'>;

export interface CompactionPlan {
  /** 被吞并的记忆 ID（调用方删除它们） */
  mergeIds: string[];
  /** 合并后的摘要记忆内容（调用方写入） */
  summary: { summary: string; importance: number; sourceCount: number; createdAt: number };
}

/**
 * 记忆超过上限时的合并方案：从最旧的、重要性 ≤ MEMORY_MERGE_MAX_IMPORTANCE 的记忆里取最多
 * MEMORY_MERGE_BATCH 条合并成一条摘要（摘要自己也可以在以后被再次合并）。
 * 重要记忆不参与；没有可合并的就不动（返回 null）。至少合并 2 条才有意义。
 */
export function planCompaction(memories: readonly Mem[], cap: number = MEMORY_CAP): CompactionPlan | null {
  if (memories.length <= cap) return null;
  const eligible = [...memories]
    .filter((m) => m.importance <= MEMORY_MERGE_MAX_IMPORTANCE)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, MEMORY_MERGE_BATCH);
  if (eligible.length < 2) return null;

  return { mergeIds: eligible.map((m) => m.id), summary: summarizeMemories(eligible) };
}

/** 把若干记忆合并成一条摘要的内容：按类型计数的模板文字，重要性取最大，时间取最晚。至少要有一条 */
export function summarizeMemories(list: readonly Mem[]): CompactionPlan['summary'] {
  const counts = new Map<MemoryType, number>();
  for (const m of list) counts.set(m.type, (counts.get(m.type) ?? 0) + m.sourceCount);
  const parts = [...counts.entries()].map(([t, n]) => (t === 'summary' ? `更早的 ${n} 件往事` : `${LABEL[t]} ${n} 次`));
  const total = list.reduce((n, m) => n + m.sourceCount, 0);
  const text = `（旧事 · 共 ${total} 件）${parts.join('，')}。`;
  return {
    summary: text.slice(0, MEMORY_LIMITS.summaryMax),
    importance: Math.max(...list.map((m) => m.importance)),
    sourceCount: Math.min(total, 10_000),
    createdAt: Math.max(...list.map((m) => m.createdAt)),
  };
}

export interface SelectOptions {
  /** 最多取几条 */
  limit?: number;
  /** 所有摘要的总字数上限（对话上下文预算） */
  maxChars?: number;
}

/**
 * 检索用于对话上下文的记忆：重要性优先，最近的略有加成；受条数与总字数预算约束，
 * 结果按时间正序返回。输入不被修改。
 */
export function selectMemories<T extends Pick<NpcMemory, 'id' | 'importance' | 'createdAt' | 'summary'>>(memories: readonly T[], opts: SelectOptions = {}): T[] {
  const limit = Math.max(0, opts.limit ?? 8);
  const maxChars = Math.max(0, opts.maxChars ?? 600);
  const byTime = [...memories].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const recency = new Map(byTime.slice(0, 3).map((m, i) => [m.id, 3 - i] as const)); // 最近三条依次 +3、+2、+1
  const ranked = [...memories].sort((a, b) => b.importance + (recency.get(b.id) ?? 0) - (a.importance + (recency.get(a.id) ?? 0)) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const picked: T[] = [];
  let chars = 0;
  for (const m of ranked) {
    if (picked.length >= limit) break;
    const len = [...m.summary].length;
    if (chars + len > maxChars) continue;
    picked.push(m);
    chars += len;
  }
  return picked.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
