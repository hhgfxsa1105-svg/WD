import { describe, expect, it } from 'vitest';
import { GRADES } from '@jhz/contracts';
import { METHOD_EXP_COEFFICIENT, PILL_BONUS_PERCENT, charmFromAppearance, charmOf, createInitialPlayer, progressGain } from '../src/index.js';

describe('功法评级经验系数', () => {
  it('凡 1.0 / 黄 1.5 / 玄 2.2 / 地 3.2 / 天 4.5，且逐级递增', () => {
    expect(METHOD_EXP_COEFFICIENT).toEqual({ fan: 1.0, huang: 1.5, xuan: 2.2, di: 3.2, tian: 4.5 });
    const xs = GRADES.map((g) => METHOD_EXP_COEFFICIENT[g]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
  it('丹药加成逐级递增', () => {
    expect(GRADES.map((g) => PILL_BONUS_PERCENT[g])).toEqual([10, 20, 30, 40, 50]);
  });
});

describe('progressGain', () => {
  it.each([
    ['凡阶无加成', 10, 'fan', 0, 10],
    ['凡阶 +5% 四舍五入', 10, 'fan', 5, 11],
    ['黄阶', 10, 'huang', 0, 15],
    ['玄阶', 10, 'xuan', 0, 22],
    ['地阶 +10%', 10, 'di', 10, 35],
    ['天阶', 10, 'tian', 0, 45],
    ['天阶 +50%', 10, 'tian', 50, 68],
  ] as const)('%s', (_n, base, grade, bonus, expected) => {
    expect(progressGain({ base, methodGrade: grade, bonusPercent: bonus })).toBe(expected);
  });

  it('加成下限 −90%，不会得到负数', () => {
    expect(progressGain({ base: 10, methodGrade: 'fan', bonusPercent: -500 })).toBe(1);
    expect(progressGain({ base: 0, methodGrade: 'tian', bonusPercent: 100 })).toBe(0);
  });
});

describe('魅力（隐藏属性）', () => {
  it('每 10 分 1 点，范围 0–10', () => {
    expect([0, 9, 10, 55, 99, 100, 150, -5].map(charmFromAppearance)).toEqual([0, 0, 1, 5, 9, 10, 10, 0]);
  });
  it('由称号决定；无称号或未登记按 50 分', () => {
    const p = createInitialPlayer();
    expect(charmOf(p)).toBe(5);
    expect(charmOf({ epithet: null })).toBe(5);
    expect(charmOf({ epithet: { ...p.epithet!, id: 'epithet_unknown' } })).toBe(5);
  });
  it('魅力不在契约中：玩家状态不含 charm', () => {
    expect('charm' in createInitialPlayer()).toBe(false);
  });
});
