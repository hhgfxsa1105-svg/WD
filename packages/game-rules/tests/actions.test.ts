import { describe, expect, it } from 'vitest';
import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import { RULES, createInitialPlayer, expBonusPercent, resolveFixedAction } from '../src/index.js';

const base = (): PlayerState => createInitialPlayer();
const ok = (p: PlayerState, a: 'cultivate' | 'rest') => {
  const r = resolveFixedAction(p, a);
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('初始角色', () => {
  it('通过契约校验', () => {
    expect(PlayerStateSchema.safeParse(base()).success).toBe(true);
  });
});

describe('expBonusPercent', () => {
  it('汇总名号的经验加成，忽略其他类别', () => {
    expect(expBonusPercent(base())).toBe(5);
  });
  it('无名号为 0；下限 −90', () => {
    expect(expBonusPercent({ ...base(), title: null, epithet: null, fate: null })).toBe(0);
    const p = base();
    p.title = { ...p.title!, effects: [{ kind: 'exp_multiplier', value: -500, text: 'x' }] };
    expect(expBonusPercent(p)).toBe(-90);
  });
});

describe('修炼', () => {
  it('炼体：扣体力、涨进度（含头衔加成四舍五入），无内力变化', () => {
    const r = ok(base(), 'cultivate');
    expect(r.player.stamina).toBe(50 - RULES.cultivate.staminaCost);
    expect(r.player.realmProgress).toBe(11); // 10 × 1.05 = 10.5 → 11
    expect(r.player.neili).toBeNull();
    expect(r.changes).toEqual([
      { stat: 'stamina', delta: -10 },
      { stat: 'realmProgress', delta: 11 },
    ]);
  });

  it('后天：同时增加内力，且不超过上限', () => {
    const p = { ...base(), realm: 'houtian' as const, neili: { current: 58, max: 60 } };
    const r = ok(p, 'cultivate');
    expect(r.player.neili).toEqual({ current: 60, max: 60 });
    expect(r.changes).toContainEqual({ stat: 'neili', delta: 2 });
  });

  it('进度封顶 100，且不记录 0 变化', () => {
    const r = ok({ ...base(), realmProgress: 100 }, 'cultivate');
    expect(r.player.realmProgress).toBe(100);
    expect(r.changes.find((c) => c.stat === 'realmProgress')).toBeUndefined();
  });

  it('体力不足被拒绝', () => {
    const r = resolveFixedAction({ ...base(), stamina: 9 }, 'cultivate');
    expect(r).toMatchObject({ ok: false, code: 'INSUFFICIENT_STAMINA' });
  });

  it('恰好等于消耗时可以修炼，体力降为 0 而不为负', () => {
    expect(ok({ ...base(), stamina: 10 }, 'cultivate').player.stamina).toBe(0);
  });

  it('不修改入参，结果仍通过契约校验', () => {
    const p = base();
    const snapshot = JSON.stringify(p);
    const r = ok(p, 'cultivate');
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(PlayerStateSchema.safeParse(r.player).success).toBe(true);
  });
});

describe('休息', () => {
  it('恢复体力与气血', () => {
    const r = ok({ ...base(), stamina: 20, hp: 90 }, 'rest');
    expect(r.player.stamina).toBe(35);
    expect(r.player.hp).toBe(95);
  });
  it('封顶不溢出，满值时不记录变化', () => {
    const r = ok({ ...base(), stamina: 49, hp: 100 }, 'rest');
    expect(r.player.stamina).toBe(50);
    expect(r.changes).toEqual([{ stat: 'stamina', delta: 1 }]);
  });
});
