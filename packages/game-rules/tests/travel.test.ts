import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@jhz/contracts';
import { INITIAL_VISITED, LOCATION_DEFS, LOCATION_LINKS, REGION_DEFS, areAdjacent, createInitialPlayer, isLocationId, isRegionId, linkBetween, moveCost, neighborsOf, resolveMove } from '../src/index.js';
import { createSeededRng } from '../src/rng.js';

const GATE = 'loc_qingyun_gate';
const YARD = 'loc_qingyun_yard';
const PATH = 'loc_foot_path';
const TOWN = 'loc_foot_town';
const at = (id: keyof typeof LOCATION_DEFS, stamina = 50): PlayerState => ({ ...createInitialPlayer(), stamina, location: { id, name: LOCATION_DEFS[id].name } });

describe('地区与地点定义', () => {
  it('每个地点属于已定义的地区；名字、描述长度合理；名字不重复', () => {
    const names = new Set<string>();
    for (const [id, d] of Object.entries(LOCATION_DEFS)) {
      expect(id).toMatch(/^loc_[a-z0-9_]{1,59}$/);
      expect(isRegionId(d.region)).toBe(true);
      expect(d.name.length).toBeLessThanOrEqual(32);
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.description.length).toBeLessThanOrEqual(120);
      expect(names.has(d.name)).toBe(false);
      names.add(d.name);
    }
    for (const [id, r] of Object.entries(REGION_DEFS)) {
      expect(id).toMatch(/^region_[a-z0-9_]+$/);
      expect(Object.values(LOCATION_DEFS).some((l) => l.region === id), `地区 ${r.name} 没有任何地点`).toBe(true);
    }
  });
  it('初始已去过的地点存在', () => {
    for (const id of INITIAL_VISITED) expect(isLocationId(id)).toBe(true);
    expect(INITIAL_VISITED).toContain(GATE);
  });
});

describe('地点连接', () => {
  it('每条路的两端都是已定义的地点，不指向自己，没有重复；体力与耗时是正整数', () => {
    const seen = new Set<string>();
    for (const l of LOCATION_LINKS) {
      expect(isLocationId(l.a) && isLocationId(l.b)).toBe(true);
      expect(l.a).not.toBe(l.b);
      const k = [l.a, l.b].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(Number.isInteger(l.stamina) && l.stamina > 0).toBe(true);
      expect(Number.isInteger(l.minutes) && l.minutes > 0).toBe(true);
    }
  });
  it('相邻与耗时是对称的；从山门出发能走到所有地点（图是连通的）', () => {
    for (const l of LOCATION_LINKS) {
      expect(areAdjacent(l.a, l.b)).toBe(true);
      expect(areAdjacent(l.b, l.a)).toBe(true);
      expect(moveCost(l.a, l.b)).toEqual(moveCost(l.b, l.a));
      expect(linkBetween(l.a, l.b)).toBe(linkBetween(l.b, l.a));
    }
    const seen = new Set<string>([GATE]);
    const queue: string[] = [GATE];
    while (queue.length) for (const n of neighborsOf(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
    expect([...seen].sort()).toEqual(Object.keys(LOCATION_DEFS).sort());
  });
  it('山门连着练功场和山道；小镇只通山道，不能直达', () => {
    expect(neighborsOf(GATE).sort()).toEqual([PATH, YARD].sort());
    expect(neighborsOf(TOWN)).toEqual([PATH]);
    expect(areAdjacent(GATE, TOWN)).toBe(false);
    expect(areAdjacent(GATE, 'loc_qingyun_hall')).toBe(false);
  });
  it('每条路的耗时单独定义：山下的路比山上的更远', () => {
    expect(moveCost(GATE, YARD)).toEqual({ stamina: 3, minutes: 30 });
    expect(moveCost(GATE, PATH)).toEqual({ stamina: 3, minutes: 60 });
    expect(moveCost(PATH, TOWN)!.minutes).toBeGreaterThan(moveCost(GATE, YARD)!.minutes);
    expect(moveCost(GATE, TOWN)).toBeNull();
    expect(moveCost('loc_nowhere', GATE)).toBeNull();
  });
});

describe('resolveMove', () => {
  it('前往相邻地点：位置与名字更新、体力按这条路扣除、返回变化、叙事与耗时；不修改入参', () => {
    const p = at(GATE);
    const copy = structuredClone(p);
    const r = resolveMove(p, PATH);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.player.location).toEqual({ id: PATH, name: '山下 · 山道' });
    expect(r.player.stamina).toBe(50 - moveCost(GATE, PATH)!.stamina);
    expect(r.changes).toEqual([{ stat: 'stamina', delta: -moveCost(GATE, PATH)!.stamina }]);
    expect(r.narrative).toContain('山道');
    expect(r.minutes).toBe(60);
    expect(p).toEqual(copy);
  });
  it.each([
    ['未知地点', 'loc_nowhere', 'UNKNOWN_LOCATION'],
    ['显示名当 ID', '青云山 · 练功场', 'UNKNOWN_LOCATION'],
    ['原型链名字', 'constructor', 'UNKNOWN_LOCATION'],
    ['原地不动', GATE, 'ALREADY_THERE'],
    ['不相邻（山门到大殿）', 'loc_qingyun_hall', 'NOT_ADJACENT'],
    ['不相邻（山门到小镇）', TOWN, 'NOT_ADJACENT'],
  ])('拒绝：%s', (_n, to, code) => {
    expect(resolveMove(at(GATE), to)).toMatchObject({ ok: false, code });
  });
  it('体力边界：恰好够可以走，差一点不行；体力为 0 不行', () => {
    const need = moveCost(GATE, YARD)!.stamina;
    expect(resolveMove(at(GATE, need), YARD).ok).toBe(true);
    expect(resolveMove(at(GATE, need - 1), YARD)).toMatchObject({ ok: false, code: 'INSUFFICIENT_STAMINA' });
    expect(resolveMove(at(GATE, 0), YARD)).toMatchObject({ ok: false, code: 'INSUFFICIENT_STAMINA' });
  });
  it('封锁：目的地被封锁时过不去并给出原因；封锁判定先于体力；离开被封锁的地方不受限制', () => {
    const blocked = (id: string) => (id === PATH ? '山道被劫匪封住了' : null);
    expect(resolveMove(at(GATE), PATH, blocked)).toEqual({ ok: false, code: 'BLOCKED', message: '过不去：山道被劫匪封住了' });
    expect(resolveMove(at(GATE, 0), PATH, blocked)).toMatchObject({ code: 'BLOCKED' }); // 体力不足时也先告诉你路被封了
    expect(resolveMove(at(GATE), YARD, blocked).ok).toBe(true); // 其他方向不受影响
    expect(resolveMove(at(PATH), GATE, (id) => (id === PATH ? '被封' : null)).ok).toBe(true); // 站在被封的地方可以离开
    expect(resolveMove(at(GATE), PATH, () => null).ok).toBe(true);
  });
  it('性质：随机行走时位置始终是已定义地点、体力不为负、每步只走相邻的地方、被封锁的地方进不去', () => {
    const rng = createSeededRng(5);
    const ids = Object.keys(LOCATION_DEFS) as (keyof typeof LOCATION_DEFS)[];
    for (let run = 0; run < 50; run++) {
      let p = at(GATE, 30);
      const blockedSet = new Set(ids.filter(() => rng() < 0.2));
      for (let i = 0; i < 100; i++) {
        const to = ids[Math.floor(rng() * ids.length)]!;
        const r = resolveMove(p, to, (id) => (blockedSet.has(id as never) ? '封' : null));
        if (r.ok) {
          expect(areAdjacent(p.location.id, to)).toBe(true);
          expect(blockedSet.has(to)).toBe(false);
          p = r.player;
        }
        expect(isLocationId(p.location.id)).toBe(true);
        expect(p.stamina).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
