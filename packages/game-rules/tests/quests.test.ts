import { describe, expect, it } from 'vitest';
import { QUEST_STATUSES, REALMS, type QuestStatus } from '@jhz/contracts';
import { ITEM_DEFS, LOCATION_DEFS, NPC_DEFS, QUEST_DEFS, QUEST_TRANSITIONS, advanceSteps, canTransition, conditionMet, initialQuestStatus, isNpcId, isQuestId, rewardLines, type QuestCondition, type QuestFacts } from '../src/index.js';

const facts = (over: Partial<{ loc: string; progress: number; realm: (typeof REALMS)[number]; met: string[] }> = {}): QuestFacts => ({
  player: { location: { id: over.loc ?? 'loc_qingyun_gate', name: 'x' }, realmProgress: over.progress ?? 0, realm: over.realm ?? 'body_tempering' },
  metNpcs: new Set(over.met ?? []),
});

describe('任务定义的引用完整性', () => {
  const defs = Object.entries(QUEST_DEFS);
  it('ID 格式、名字与说明长度', () => {
    for (const [id, d] of defs) {
      expect(id).toMatch(/^quest_[a-z0-9_]{1,50}$/);
      expect(d.name.length).toBeLessThanOrEqual(32);
      expect(d.summary.length).toBeLessThanOrEqual(200);
      expect(d.steps.length).toBeGreaterThan(0);
      expect(d.steps.length).toBeLessThanOrEqual(20);
      for (const s of d.steps) expect(s.text.length).toBeLessThanOrEqual(80);
    }
  });
  it('前置任务存在且没有循环；至少有一个无前置的起点任务', () => {
    expect(defs.some(([, d]) => d.requires === null)).toBe(true);
    for (const [id] of defs) {
      const seen = new Set<string>();
      for (let cur: string | null = id; cur; cur = QUEST_DEFS[cur as keyof typeof QUEST_DEFS].requires) {
        expect(isQuestId(cur)).toBe(true);
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
      }
    }
  });
  it('步骤条件引用的 NPC、地点、境界都存在；进度条件在 1..100', () => {
    for (const [, d] of defs) {
      for (const s of d.steps) {
        const c: QuestCondition = s.condition;
        if (c.kind === 'met_npc') expect(isNpcId(c.npcId)).toBe(true);
        if (c.kind === 'at_location') expect(Object.keys(LOCATION_DEFS)).toContain(c.locationId);
        if (c.kind === 'realm_at_least') expect(REALMS).toContain(c.realm);
        if (c.kind === 'progress_at_least') expect(c.value >= 1 && c.value <= 100).toBe(true);
      }
    }
  });
  it('奖励：物品存在、数量为正整数、货币为非负整数；反应的 NPC 存在', () => {
    for (const [, d] of defs) {
      for (const it of d.reward.items ?? []) {
        expect(Object.keys(ITEM_DEFS)).toContain(it.itemId);
        expect(Number.isInteger(it.quantity) && it.quantity > 0).toBe(true);
      }
      for (const v of Object.values(d.reward.currency ?? {})) expect(Number.isInteger(v) && v >= 0).toBe(true);
      if (d.reaction) expect(Object.keys(NPC_DEFS)).toContain(d.reaction.npcId);
    }
  });
});

describe('状态机', () => {
  it('转移表覆盖全部状态，终态没有出口', () => {
    expect(Object.keys(QUEST_TRANSITIONS).sort()).toEqual([...QUEST_STATUSES].sort());
    expect(QUEST_TRANSITIONS.completed).toEqual([]);
    expect(QUEST_TRANSITIONS.failed).toEqual([]);
  });
  it('只允许 locked→available→active→completed|failed', () => {
    const allowed = new Set(['locked>available', 'available>active', 'active>completed', 'active>failed']);
    for (const a of QUEST_STATUSES) for (const b of QUEST_STATUSES) expect(canTransition(a as QuestStatus, b as QuestStatus), `${a}>${b}`).toBe(allowed.has(`${a}>${b}`));
  });
  it('初始状态：无前置为 available，有前置为 locked', () => {
    expect(initialQuestStatus('quest_first_steps')).toBe('available');
    expect(initialQuestStatus('quest_prove_yourself')).toBe('locked');
  });
});

describe('条件判定', () => {
  it('每种条件只看已保存的事实', () => {
    expect(conditionMet({ kind: 'met_npc', npcId: 'npc_gate_guard' }, facts({ met: ['npc_gate_guard'] }))).toBe(true);
    expect(conditionMet({ kind: 'met_npc', npcId: 'npc_gate_guard' }, facts())).toBe(false);
    expect(conditionMet({ kind: 'at_location', locationId: 'loc_qingyun_yard' }, facts({ loc: 'loc_qingyun_yard' }))).toBe(true);
    expect(conditionMet({ kind: 'at_location', locationId: 'loc_qingyun_yard' }, facts())).toBe(false);
    expect(conditionMet({ kind: 'progress_at_least', value: 50 }, facts({ progress: 50 }))).toBe(true);
    expect(conditionMet({ kind: 'progress_at_least', value: 50 }, facts({ progress: 49 }))).toBe(false);
    expect(conditionMet({ kind: 'realm_at_least', realm: 'opening' }, facts({ realm: 'houtian' }))).toBe(true);
    expect(conditionMet({ kind: 'realm_at_least', realm: 'opening' }, facts({ realm: 'body_tempering' }))).toBe(false);
  });
});

describe('advanceSteps：按顺序推进', () => {
  const def = QUEST_DEFS.quest_first_steps; // 相识守门人 → 到练功场 → 相识大师姐
  it('后面的条件成立也不能跳过前面未完成的步骤', () => {
    expect(advanceSteps(def, 0, facts({ loc: 'loc_qingyun_yard', met: ['npc_senior_sister'] }))).toBe(0);
  });
  it('一次可以连续推进多步；全部满足则等于步骤总数', () => {
    expect(advanceSteps(def, 0, facts({ met: ['npc_gate_guard'] }))).toBe(1);
    expect(advanceSteps(def, 0, facts({ loc: 'loc_qingyun_yard', met: ['npc_gate_guard'] }))).toBe(2);
    expect(advanceSteps(def, 0, facts({ loc: 'loc_qingyun_yard', met: ['npc_gate_guard', 'npc_senior_sister'] }))).toBe(3);
  });
  it('进度只增不减：条件后来不再成立也不会倒退；越界输入被夹住', () => {
    expect(advanceSteps(def, 2, facts())).toBe(2);
    expect(advanceSteps(def, 99, facts())).toBe(def.steps.length);
    expect(advanceSteps(def, -5, facts())).toBe(0);
  });
});

describe('rewardLines', () => {
  it('货币与物品的展示文字', () => {
    const name = (id: string) => ITEM_DEFS[id]?.name ?? id;
    expect(rewardLines(QUEST_DEFS.quest_first_steps.reward, name)).toEqual(['铜钱 100']);
    expect(rewardLines(QUEST_DEFS.quest_prove_yourself.reward, name)).toEqual(['银两 20', '凡阶突破丹 ×1']);
    expect(rewardLines({}, name)).toEqual([]);
  });
});
