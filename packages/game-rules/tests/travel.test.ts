import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@jhz/contracts';
import { createInitialPlayer, LOCATION_DEFS, LOCATION_LINKS, MOVE_STAMINA_COST, areAdjacent, isLocationId, neighborsOf, resolveMove } from '../src/index.js';
import { createSeededRng } from '../src/rng.js';

const at = (id: keyof typeof LOCATION_DEFS, stamina = 50): PlayerState => ({ ...createInitialPlayer(), stamina, location: { id, name: LOCATION_DEFS[id].name } });

describe('地点连接', () => {
  it('每条连接的两端都是已定义的地点，不指向自己，且没有重复', () => {
    const seen = new Set<string>();
    for (const [a, b] of LOCATION_LINKS) {
      expect(isLocationId(a) && isLocationId(b)).toBe(true);
      expect(a).not.toBe(b);
      const k = [a, b].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
  it('相邻是对称的；从山门出发能走到所有地点（图是连通的）', () => {
    for (const [a, b] of LOCATION_LINKS) {
      expect(areAdjacent(a, b)).toBe(true);
      expect(areAdjacent(b, a)).toBe(true);
    }
    const seen = new Set<string>(['loc_qingyun_gate']);
    const queue = ['loc_qingyun_gate'];
    while (queue.length) for (const n of neighborsOf(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
    expect([...seen].sort()).toEqual(Object.keys(LOCATION_DEFS).sort());
  });
  it('山门只与练功场相连，不能直达大殿', () => {
    expect(neighborsOf('loc_qingyun_gate')).toEqual(['loc_qingyun_yard']);
    expect(areAdjacent('loc_qingyun_gate', 'loc_qingyun_hall')).toBe(false);
  });
});

describe('resolveMove', () => {
  it('前往相邻地点：位置与名字更新、体力 −3、返回变化与叙事；不修改入参', () => {
    const p = at('loc_qingyun_gate');
    const copy = structuredClone(p);
    const r = resolveMove(p, 'loc_qingyun_yard');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.player.location).toEqual({ id: 'loc_qingyun_yard', name: '青云山 · 练功场' });
    expect(r.player.stamina).toBe(50 - MOVE_STAMINA_COST);
    expect(r.changes).toEqual([{ stat: 'stamina', delta: -MOVE_STAMINA_COST }]);
    expect(r.narrative).toContain('练功场');
    expect(p).toEqual(copy);
  });
  it.each([
    ['未知地点', 'loc_nowhere', 'UNKNOWN_LOCATION'],
    ['显示名当 ID', '青云山 · 练功场', 'UNKNOWN_LOCATION'],
    ['原型链名字', 'constructor', 'UNKNOWN_LOCATION'],
    ['原地不动', 'loc_qingyun_gate', 'ALREADY_THERE'],
    ['不相邻', 'loc_qingyun_hall', 'NOT_ADJACENT'],
  ])('拒绝：%s', (_n, to, code) => {
    expect(resolveMove(at('loc_qingyun_gate'), to)).toMatchObject({ ok: false, code });
  });
  it('体力边界：恰好够（3）可以走，差一点（2）不行；体力为 0 不行', () => {
    expect(resolveMove(at('loc_qingyun_gate', MOVE_STAMINA_COST), 'loc_qingyun_yard').ok).toBe(true);
    expect(resolveMove(at('loc_qingyun_gate', MOVE_STAMINA_COST - 1), 'loc_qingyun_yard')).toMatchObject({ ok: false, code: 'INSUFFICIENT_STAMINA' });
    expect(resolveMove(at('loc_qingyun_gate', 0), 'loc_qingyun_yard')).toMatchObject({ ok: false, code: 'INSUFFICIENT_STAMINA' });
  });
  it('性质：随机行走时位置始终是已定义地点、体力不为负、每步只走相邻的地方', () => {
    const rng = createSeededRng(5);
    const ids = Object.keys(LOCATION_DEFS) as (keyof typeof LOCATION_DEFS)[];
    for (let run = 0; run < 50; run++) {
      let p = at('loc_qingyun_gate', 30);
      for (let i = 0; i < 100; i++) {
        const to = ids[Math.floor(rng() * ids.length)]!;
        const r = resolveMove(p, to);
        if (r.ok) {
          expect(areAdjacent(p.location.id, to)).toBe(true);
          p = r.player;
        }
        expect(isLocationId(p.location.id)).toBe(true);
        expect(p.stamina).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
