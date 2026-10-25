import { describe, expect, it } from 'vitest';
import { PlayerStateSchema, REALMS, type PlayerState, type Realm } from '@jhz/contracts';
import {
  BREAKTHROUGH,
  BREAKTHROUGH_RULES,
  attributeScore,
  breakthroughChance,
  createInitialPlayer,
  createSeededRng,
  fixedRng,
  nextRealm,
  resolveBreakthrough,
} from '../src/index.js';

const NOW = 1_800_000_000_000;
const ready = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createInitialPlayer(), realmProgress: 100, ...patch });
const withAttrs = (con: number, comp: number, spirit: number): PlayerState['attributes'] => ({
  ...createInitialPlayer().attributes,
  constitution: con,
  comprehension: comp,
  spirit,
});
const ok = (r: ReturnType<typeof resolveBreakthrough>) => {
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('综合分与成功率', () => {
  it('综合分 = 根骨×40% + 悟性×40% + 神×20%', () => {
    expect(attributeScore({ constitution: 10, comprehension: 10, spirit: 10 })).toBeCloseTo(10);
    expect(attributeScore({ constitution: 10, comprehension: 0, spirit: 0 })).toBeCloseTo(4);
    expect(attributeScore({ constitution: 0, comprehension: 0, spirit: 10 })).toBeCloseTo(2);
  });

  it('综合分恰为要求分时，成功率等于基础率', () => {
    for (const realm of REALMS.slice(0, -1)) {
      const row = BREAKTHROUGH[realm as Exclude<Realm, 'land_immortal'>];
      const s = row.requiredScore;
      const c = breakthroughChance({ realm, attributes: withAttrs(s, s, s) })!;
      expect(c.attributeBonus).toBe(0);
      expect(c.percent).toBe(row.basePercent);
    }
  });

  it('每高 1 分 +2 个百分点，低于要求为负', () => {
    // 炼体要求 5，综合分 8 → +6
    expect(breakthroughChance({ realm: 'body_tempering', attributes: withAttrs(8, 8, 8) })!.percent).toBe(76);
    // 综合分 3 → −4
    expect(breakthroughChance({ realm: 'body_tempering', attributes: withAttrs(3, 3, 3) })!.percent).toBe(66);
  });

  it('根骨、悟性权重大于神', () => {
    const base = { realm: 'opening' as const };
    const a = breakthroughChance({ ...base, attributes: withAttrs(20, 10, 10) })!.percent;
    const b = breakthroughChance({ ...base, attributes: withAttrs(10, 10, 20) })!.percent;
    expect(a).toBeGreaterThan(b);
  });

  it('丹药按评级加成，并与属性加成叠加', () => {
    const p = { realm: 'houtian' as const, attributes: withAttrs(20, 20, 20) };
    expect(breakthroughChance(p, null)!.percent).toBe(35);
    expect(breakthroughChance(p, 'fan')!.percent).toBe(45);
    expect(breakthroughChance(p, 'tian')!.percent).toBe(85);
    expect(breakthroughChance(p, 'tian')!.pillBonus).toBe(50);
  });

  it('成功率限制在 5%–95%', () => {
    expect(breakthroughChance({ realm: 'body_tempering', attributes: withAttrs(500, 500, 500) }, 'tian')!.percent).toBe(95);
    expect(breakthroughChance({ realm: 'mingshen', attributes: withAttrs(0, 0, 0) })!.percent).toBe(5);
  });

  it('最高境界没有下一境界与成功率', () => {
    expect(breakthroughChance({ realm: 'land_immortal', attributes: withAttrs(1, 1, 1) })).toBeNull();
    expect(nextRealm('land_immortal')).toBeNull();
    expect(nextRealm('body_tempering')).toBe('opening');
  });

  it('境界顺序与基础率逐级降低', () => {
    expect(REALMS.slice(0, -1).map((r) => nextRealm(r))).toEqual(REALMS.slice(1));
    const bases = REALMS.slice(0, -1).map((r) => BREAKTHROUGH[r as Exclude<Realm, 'land_immortal'>].basePercent);
    expect([...bases].sort((a, b) => b - a)).toEqual(bases);
  });
});

describe('突破前置条件', () => {
  it('进度未满被拒绝', () => {
    const r = resolveBreakthrough(ready({ realmProgress: 99 }), { now: NOW, rng: fixedRng(0) });
    expect(r).toMatchObject({ ok: false, code: 'PROGRESS_NOT_FULL' });
  });

  it('冷却中被拒绝并返回可再试时间；恰好到点可以突破', () => {
    const p = ready({ breakthroughAvailableAt: NOW + 1000 });
    expect(resolveBreakthrough(p, { now: NOW, rng: fixedRng(0) })).toMatchObject({ ok: false, code: 'COOLDOWN', availableAt: NOW + 1000 });
    expect(resolveBreakthrough(p, { now: NOW + 999, rng: fixedRng(0) }).ok).toBe(false);
    expect(resolveBreakthrough(p, { now: NOW + 1000, rng: fixedRng(0) }).ok).toBe(true);
  });

  it('最高境界被拒绝', () => {
    const p = ready({ realm: 'land_immortal', neili: { current: 1, max: 100 } });
    expect(resolveBreakthrough(p, { now: NOW, rng: fixedRng(0) })).toMatchObject({ ok: false, code: 'MAX_REALM' });
  });

  it('被拒绝时不修改入参，也不消耗随机数', () => {
    const p = ready({ realmProgress: 50 });
    const snapshot = JSON.stringify(p);
    let calls = 0;
    resolveBreakthrough(p, { now: NOW, rng: () => (calls++, 0) });
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(calls).toBe(0);
  });
});

describe('突破成功', () => {
  it('炼体→通窍：进度清零、上限提升，仍无内力', () => {
    const r = ok(resolveBreakthrough(ready(), { now: NOW, rng: fixedRng(0) }));
    expect(r.outcome).toBe('success');
    expect(r.player.realm).toBe('opening');
    expect(r.player.realmProgress).toBe(0);
    expect(r.player.maxHp).toBe(130);
    expect(r.player.maxStamina).toBe(55);
    expect(r.player.neili).toBeNull();
    expect(r.player.breakthroughAvailableAt).toBeNull();
    expect(PlayerStateSchema.safeParse(r.player).success).toBe(true);
  });

  it('通窍→后天：首次获得内力 0/60', () => {
    const r = ok(resolveBreakthrough(ready({ realm: 'opening' }), { now: NOW, rng: fixedRng(0), pillGrade: 'tian' }));
    expect(r.player.realm).toBe('houtian');
    expect(r.player.neili).toEqual({ current: 0, max: 60 });
    expect(PlayerStateSchema.safeParse(r.player).success).toBe(true);
  });

  it('后天及以上每次晋级内力上限 +60，当前内力保留', () => {
    const p = ready({ realm: 'houtian', neili: { current: 25, max: 60 } });
    const r = ok(resolveBreakthrough(p, { now: NOW, rng: fixedRng(0) }));
    expect(r.player.realm).toBe('xiantian');
    expect(r.player.neili).toEqual({ current: 25, max: 120 });
  });

  it('成功清除之前的冷却记录', () => {
    const r = ok(resolveBreakthrough(ready({ breakthroughAvailableAt: NOW - 1 }), { now: NOW, rng: fixedRng(0) }));
    expect(r.player.breakthroughAvailableAt).toBeNull();
  });

  it('逐级突破到陆地神仙，每一步状态都通过契约校验', () => {
    let p = ready();
    for (let i = 0; i < REALMS.length - 1; i++) {
      p = ok(resolveBreakthrough({ ...p, realmProgress: 100 }, { now: NOW, rng: fixedRng(0) })).player;
      expect(PlayerStateSchema.safeParse(p).success).toBe(true);
    }
    expect(p.realm).toBe('land_immortal');
    expect(p.neili).toEqual({ current: 0, max: 60 + 60 * 4 });
  });

  it('变化摘要包含进度清零与上限提升', () => {
    const r = ok(resolveBreakthrough(ready(), { now: NOW, rng: fixedRng(0) }));
    expect(r.changes).toEqual([
      { stat: 'realmProgress', delta: -100 },
      { stat: 'maxHp', delta: 30 },
      { stat: 'maxStamina', delta: 5 },
    ]);
  });
});

describe('突破失败', () => {
  const fail = (p = ready(), pill: 'fan' | null = null) => ok(resolveBreakthrough(p, { now: NOW, rng: fixedRng(0.9999), pillGrade: pill }));

  it('进度回落 20、气血 −20%、冷却 24 小时、不掉境界', () => {
    const r = fail();
    expect(r.outcome).toBe('failure');
    expect(r.player.realm).toBe('body_tempering');
    expect(r.player.realmProgress).toBe(80);
    expect(r.player.hp).toBe(80);
    expect(r.player.breakthroughAvailableAt).toBe(NOW + BREAKTHROUGH_RULES.cooldownMs);
    expect(r.changes).toEqual([
      { stat: 'realmProgress', delta: -20 },
      { stat: 'hp', delta: -20 },
    ]);
  });

  it('气血很低时至少保留 1 点，不会致死', () => {
    expect(fail(ready({ hp: 5 })).player.hp).toBe(1);
    expect(fail(ready({ hp: 1 })).player.hp).toBe(1);
  });

  it('失败后冷却期内不能再次突破，24 小时后可以', () => {
    const after = fail().player;
    const retry = (now: number) => resolveBreakthrough({ ...after, realmProgress: 100 }, { now, rng: fixedRng(0) });
    expect(retry(NOW + BREAKTHROUGH_RULES.cooldownMs - 1)).toMatchObject({ ok: false, code: 'COOLDOWN' });
    expect(retry(NOW + BREAKTHROUGH_RULES.cooldownMs).ok).toBe(true);
  });

  it('失败后进度低于 100，需要重新修炼才能再试', () => {
    const after = fail().player;
    expect(resolveBreakthrough(after, { now: NOW + BREAKTHROUGH_RULES.cooldownMs, rng: fixedRng(0) })).toMatchObject({
      ok: false,
      code: 'PROGRESS_NOT_FULL',
    });
  });

  it('结果通过契约校验', () => {
    expect(PlayerStateSchema.safeParse(fail().player).success).toBe(true);
  });
});

describe('掷点判定与可复现', () => {
  it('掷点严格小于成功率才成功（边界）', () => {
    // 炼体、综合分 5：成功率 70%
    const at = (v: number) => ok(resolveBreakthrough(ready(), { now: NOW, rng: fixedRng(v) }));
    expect(at(0.6999).outcome).toBe('success');
    expect(at(0.7).outcome).toBe('failure');
    expect(at(0.7).roll).toBe(70);
    expect(at(0.7).chancePercent).toBe(70);
  });

  it('丹药提高成功率：同一掷点下由失败变成功', () => {
    const roll = 0.75;
    expect(ok(resolveBreakthrough(ready(), { now: NOW, rng: fixedRng(roll) })).outcome).toBe('failure');
    expect(ok(resolveBreakthrough(ready(), { now: NOW, rng: fixedRng(roll), pillGrade: 'fan' })).outcome).toBe('success');
  });

  it('固定种子结果完全可复现', () => {
    const run = () => ok(resolveBreakthrough(ready(), { now: NOW, rng: createSeededRng(99) }));
    expect(run()).toEqual(run());
  });

  it('大量样本的成功频率与成功率一致（固定种子，确定性）', () => {
    const rng = createSeededRng(12345);
    let wins = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) wins += ok(resolveBreakthrough(ready(), { now: NOW, rng })).outcome === 'success' ? 1 : 0;
    expect(wins / N).toBeGreaterThan(0.68);
    expect(wins / N).toBeLessThan(0.72);
  });
});
