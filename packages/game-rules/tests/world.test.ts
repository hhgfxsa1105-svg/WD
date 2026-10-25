import { describe, expect, it } from 'vitest';
import {
  INITIAL_RELATIONS,
  LOCATION_DEFS,
  NPC_DEFS,
  RELATION_MAX_STEP,
  RELATION_RANGE,
  applyRelationDelta,
  clampRelation,
  defaultCatalog,
  isLocationId,
  isNpcId,
  type RelationValues,
} from '../src/index.js';
import { createSeededRng } from '../src/rng.js';

const rel = (affinity = 0, trust = 0, hostility = 0): RelationValues => ({ affinity, trust, hostility });
const inRange = (v: RelationValues) =>
  v.affinity >= RELATION_RANGE.affinity.min && v.affinity <= RELATION_RANGE.affinity.max && v.trust >= RELATION_RANGE.trust.min && v.trust <= RELATION_RANGE.trust.max && v.hostility >= RELATION_RANGE.hostility.min && v.hostility <= RELATION_RANGE.hostility.max && [v.affinity, v.trust, v.hostility].every(Number.isInteger);

describe('世界定义：实体 ID 稳定、引用完整', () => {
  it('ID 格式：npc_ / loc_ 前缀，只含小写字母数字下划线，长度受限', () => {
    for (const id of Object.keys(NPC_DEFS)) expect(id).toMatch(/^npc_[a-z0-9_]{1,59}$/);
    for (const id of Object.keys(LOCATION_DEFS)) expect(id).toMatch(/^loc_[a-z0-9_]{1,59}$/);
  });
  it('每个 NPC 的初始地点都存在；名字不重复（显示名不能当引用）', () => {
    for (const d of Object.values(NPC_DEFS)) expect(isLocationId(d.homeLocationId)).toBe(true);
    const names = Object.values(NPC_DEFS).map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of Object.values(NPC_DEFS)) {
      expect(d.goals.length).toBeLessThanOrEqual(5);
      for (const g of d.goals) expect(g.length).toBeLessThanOrEqual(60);
    }
  });
  it('初始关系：双方都存在、不指向自己、数值合法、没有重复的有向边', () => {
    const seen = new Set<string>();
    for (const r of INITIAL_RELATIONS) {
      expect(isNpcId(r.npcId)).toBe(true);
      if (r.targetType === 'npc') {
        expect(isNpcId(r.targetId)).toBe(true);
        expect(r.targetId).not.toBe(r.npcId);
      } else expect(r.targetId).toBe('player_1');
      expect(inRange(r)).toBe(true);
      const k = `${r.npcId}>${r.targetType}:${r.targetId}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
  it('每个 NPC 都有对玩家的初始关系', () => {
    for (const id of Object.keys(NPC_DEFS)) expect(INITIAL_RELATIONS.some((r) => r.npcId === id && r.targetType === 'player')).toBe(true);
  });
  it('实体目录：已知 NPC/地点存在；原型链上的名字与显示名都不是实体', () => {
    expect(defaultCatalog.npcExists('npc_master_qingyun')).toBe(true);
    expect(defaultCatalog.locationExists('loc_qingyun_library')).toBe(true);
    for (const bad of ['青云真人', 'npc_nobody', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      expect(defaultCatalog.npcExists(bad), bad).toBe(false);
      expect(defaultCatalog.locationExists(bad), bad).toBe(false);
    }
  });
});

describe('关系数值规则', () => {
  it('范围：好感 −100..100，信任与敌意 0..100', () => {
    expect(RELATION_RANGE).toEqual({ affinity: { min: -100, max: 100 }, trust: { min: 0, max: 100 }, hostility: { min: 0, max: 100 } });
  });
  it('变化在边界处被夹住', () => {
    expect(applyRelationDelta(rel(95, 95, 95), { affinity: 20, trust: 20, hostility: 20 })).toEqual(rel(100, 100, 100));
    expect(applyRelationDelta(rel(-95, 5, 5), { affinity: -20, trust: -20, hostility: -20 })).toEqual(rel(-100, 0, 0));
  });
  it('单次变化每项限幅 ±RELATION_MAX_STEP', () => {
    expect(RELATION_MAX_STEP).toBe(20);
    expect(applyRelationDelta(rel(0, 50, 50), { affinity: 9999, trust: -9999, hostility: 21 })).toEqual(rel(20, 30, 70));
  });
  it('没给的项不变；非法数值（NaN、Infinity、小数）被安全处理', () => {
    expect(applyRelationDelta(rel(10, 20, 30), {})).toEqual(rel(10, 20, 30));
    expect(applyRelationDelta(rel(10, 20, 30), { affinity: Number.NaN, trust: Number.POSITIVE_INFINITY, hostility: 2.6 })).toEqual(rel(10, 20, 33));
    expect(clampRelation({ affinity: Number.NaN, trust: 1e9, hostility: -5 })).toEqual(rel(0, 100, 0));
  });
  it('性质：任意起点、任意（含极端）变化序列后，数值始终是范围内的整数', () => {
    const rng = createSeededRng(7);
    const pick = () => {
      const r = rng();
      return r < 0.1 ? Number.NaN : r < 0.2 ? 1e12 : r < 0.3 ? -1e12 : Math.round((rng() - 0.5) * 80);
    };
    for (let run = 0; run < 200; run++) {
      let cur = clampRelation({ affinity: (rng() - 0.5) * 400, trust: (rng() - 0.5) * 400, hostility: (rng() - 0.5) * 400 });
      for (let i = 0; i < 50; i++) {
        const before = cur;
        cur = applyRelationDelta(cur, { affinity: pick(), trust: pick(), hostility: pick() });
        expect(inRange(cur)).toBe(true);
        expect(Math.abs(cur.affinity - before.affinity)).toBeLessThanOrEqual(RELATION_MAX_STEP);
        expect(Math.abs(cur.trust - before.trust)).toBeLessThanOrEqual(RELATION_MAX_STEP);
        expect(Math.abs(cur.hostility - before.hostility)).toBeLessThanOrEqual(RELATION_MAX_STEP);
      }
    }
  });
});
