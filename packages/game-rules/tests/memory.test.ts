import { describe, expect, it } from 'vitest';
import type { NpcMemory } from '@jhz/contracts';
import { MEMORY_CAP, MEMORY_EVENTS, MEMORY_MERGE_BATCH, MEMORY_MERGE_MAX_IMPORTANCE, NPC_DEFS, memorySummary, planCompaction, selectMemories, summarizeMemories } from '../src/index.js';
import { createSeededRng } from '../src/rng.js';

let n = 0;
const mem = (over: Partial<NpcMemory> = {}): NpcMemory => ({
  id: `m${String(++n).padStart(5, '0')}`,
  npcId: 'npc_gate_guard',
  eventId: 'e',
  type: 'breakthrough_failure',
  summary: '看见你突破失败。',
  importance: 3,
  sourceCount: 1,
  createdAt: n * 1000,
  ...over,
});

describe('记忆事件表与摘要模板', () => {
  it('每种事件的重要性在 1..10，关系变化在单次上限内', () => {
    for (const d of Object.values(MEMORY_EVENTS)) {
      expect(d.importance).toBeGreaterThanOrEqual(1);
      expect(d.importance).toBeLessThanOrEqual(10);
      for (const v of Object.values(d.relation)) expect(Math.abs(v)).toBeLessThanOrEqual(20);
    }
  });
  it('初次相识与突破成功不会被合并（重要性高于合并线）；突破失败可以', () => {
    expect(MEMORY_EVENTS.met.importance).toBeGreaterThan(MEMORY_MERGE_MAX_IMPORTANCE);
    expect(MEMORY_EVENTS.breakthrough_success.importance).toBeGreaterThan(MEMORY_MERGE_MAX_IMPORTANCE);
    expect(MEMORY_EVENTS.breakthrough_failure.importance).toBeLessThanOrEqual(MEMORY_MERGE_MAX_IMPORTANCE);
  });
  it('模板摘要：含人物名，突破成功含境界名；全部在长度上限内且不含数字', () => {
    for (const d of Object.values(NPC_DEFS)) {
      for (const kind of ['met', 'breakthrough_success', 'breakthrough_failure'] as const) {
        const s = memorySummary(kind, { npcName: d.name, realmTo: 'opening' });
        expect(s).toContain(d.name);
        expect(s.length).toBeLessThanOrEqual(160);
        expect(s).not.toMatch(/[0-9]/);
      }
    }
    expect(memorySummary('breakthrough_success', { npcName: '赵铁牛', realmTo: 'opening' })).toContain('通窍');
    expect(memorySummary('breakthrough_success', { npcName: '赵铁牛' })).toContain('新的境界');
  });
});

describe('planCompaction：旧记忆合并', () => {
  it('不超过上限不合并', () => {
    expect(planCompaction(Array.from({ length: MEMORY_CAP }, () => mem()))).toBeNull();
  });
  it('超过上限：合并最旧的低重要性记忆（最多一批），摘要汇总条数、取最大重要性与最晚时间', () => {
    const list = Array.from({ length: MEMORY_CAP + 3 }, () => mem());
    const plan = planCompaction(list)!;
    expect(plan.mergeIds).toEqual(list.slice(0, MEMORY_MERGE_BATCH).map((m) => m.id));
    expect(plan.summary.sourceCount).toBe(MEMORY_MERGE_BATCH);
    expect(plan.summary.importance).toBe(3);
    expect(plan.summary.createdAt).toBe(list[MEMORY_MERGE_BATCH - 1]!.createdAt);
    expect(plan.summary.summary).toContain(`共 ${MEMORY_MERGE_BATCH} 件`);
    expect(plan.summary.summary.length).toBeLessThanOrEqual(160);
  });
  it('重要记忆永不参与合并', () => {
    const important = Array.from({ length: 5 }, () => mem({ importance: 6, type: 'met' }));
    const low = Array.from({ length: MEMORY_CAP }, () => mem());
    const plan = planCompaction([...important, ...low])!;
    for (const m of important) expect(plan.mergeIds).not.toContain(m.id);
  });
  it('可合并的不足 2 条时不动', () => {
    const list = [...Array.from({ length: MEMORY_CAP }, () => mem({ importance: 7, type: 'met' })), mem(), mem({ importance: 7 })];
    expect(planCompaction(list)).toBeNull();
  });
  it('摘要可以再次被合并，条数累加', () => {
    const a = mem({ type: 'summary', eventId: null, sourceCount: 8, importance: 3 });
    const s = summarizeMemories([a, mem(), mem()]);
    expect(s.sourceCount).toBe(10);
    expect(s.summary).toContain('更早的 8 件往事');
  });
  it('性质：反复写入随机记忆并合并后，总条数受控、原始条数守恒、重要记忆一条不丢', () => {
    const rng = createSeededRng(3);
    for (let run = 0; run < 20; run++) {
      let list: NpcMemory[] = [];
      let total = 0;
      let important = 0;
      for (let i = 0; i < 300; i++) {
        const imp = rng() < 0.05 ? 6 : Math.ceil(rng() * 5);
        if (imp > MEMORY_MERGE_MAX_IMPORTANCE) important++;
        list.push(mem({ importance: imp, type: imp > 5 ? 'met' : 'breakthrough_failure' }));
        total++;
        for (let k = 0; k < 5; k++) {
          const plan = planCompaction(list);
          if (!plan) break;
          list = list.filter((m) => !plan.mergeIds.includes(m.id));
          list.push(mem({ type: 'summary', eventId: null, ...plan.summary }));
        }
      }
      expect(list.length).toBeLessThanOrEqual(MEMORY_CAP + important);
      expect(list.reduce((s, m) => s + m.sourceCount, 0)).toBe(total);
      expect(list.filter((m) => m.importance > MEMORY_MERGE_MAX_IMPORTANCE)).toHaveLength(important);
    }
  });
});

describe('selectMemories：对话上下文的检索', () => {
  it('条数与字数受限；结果按时间正序；不修改输入', () => {
    const list = Array.from({ length: 20 }, (_, i) => mem({ summary: '山'.repeat(30), importance: (i % 5) + 1 }));
    const copy = structuredClone(list);
    const out = selectMemories(list, { limit: 5, maxChars: 100 });
    expect(out.length).toBeLessThanOrEqual(3); // 100 字 / 30 字
    expect(out.reduce((s, m) => s + [...m.summary].length, 0)).toBeLessThanOrEqual(100);
    expect(out.map((m) => m.createdAt)).toEqual([...out.map((m) => m.createdAt)].sort((a, b) => a - b));
    expect(list).toEqual(copy);
    expect(selectMemories(list, { limit: 0 })).toEqual([]);
    expect(selectMemories([])).toEqual([]);
  });
  it('重要性优先；最近的略有加成', () => {
    const old = mem({ importance: 9, createdAt: 1 });
    const mid = Array.from({ length: 10 }, (_, i) => mem({ importance: 4, createdAt: 100 + i }));
    const newest = mem({ importance: 4, createdAt: 10_000 });
    const out = selectMemories([old, ...mid, newest], { limit: 3 });
    expect(out.map((m) => m.id)).toContain(old.id);
    expect(out.map((m) => m.id)).toContain(newest.id);
  });
  it('字数预算不够放一条大的时，跳过它继续放小的', () => {
    const big = mem({ importance: 9, summary: '大'.repeat(100) });
    const small = mem({ importance: 2, summary: '小' });
    expect(selectMemories([big, small], { maxChars: 10 }).map((m) => m.id)).toEqual([small.id]);
  });
});
