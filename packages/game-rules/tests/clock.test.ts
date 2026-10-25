import { describe, expect, it } from 'vitest';
import {
  ACTION_MINUTES,
  INITIAL_GAME_MINUTES,
  LOCATION_LINKS,
  MAX_ADVANCE_MINUTES,
  MINUTES_PER_DAY,
  MINUTES_PER_SHICHEN,
  SHICHEN_NAMES,
  formatGameDuration,
  gameDate,
  idleGameMinutes,
  IDLE_CULTIVATION,
  moveMinutes,
  OFFLINE,
} from '../src/index.js';

describe('游戏日期', () => {
  it('起点是第 1 天辰时', () => {
    expect(gameDate(0)).toMatchObject({ day: 1, hour: 0, shichen: '子' });
    expect(gameDate(INITIAL_GAME_MINUTES)).toMatchObject({ day: 1, shichen: '辰', label: '第 1 天 · 辰时' });
  });
  it('一天 12 个时辰，每个 2 小时；子时跨 23:00–01:00', () => {
    expect(MINUTES_PER_DAY).toBe(12 * MINUTES_PER_SHICHEN);
    expect(gameDate(23 * 60).shichen).toBe('子');
    expect(gameDate(59).shichen).toBe('子');
    expect(gameDate(60).shichen).toBe('丑'); // 01:00 起是丑时
    expect(gameDate(3 * 60 - 1).shichen).toBe('丑');
    expect(gameDate(3 * 60).shichen).toBe('寅');
    expect(gameDate(12 * 60).shichen).toBe('午');
    expect(gameDate(22 * 60 + 59).shichen).toBe('亥');
    // 一整天里每个时辰恰好出现，且各占 120 分钟（子时分在一天的头尾）
    const count = new Map<string, number>();
    for (let m = 0; m < MINUTES_PER_DAY; m++) count.set(gameDate(m).shichen, (count.get(gameDate(m).shichen) ?? 0) + 1);
    expect([...count.keys()].sort()).toEqual([...SHICHEN_NAMES].sort());
    expect([...count.values()].every((v) => v === 120)).toBe(true);
  });
  it('跨天：天数 +1，时分归位', () => {
    expect(gameDate(MINUTES_PER_DAY)).toMatchObject({ day: 2, hour: 0, minute: 0 });
    expect(gameDate(3 * MINUTES_PER_DAY + 7 * 60 + 5)).toMatchObject({ day: 4, hour: 7, minute: 5, shichen: '辰' });
  });
  it('拒绝负数与非整数', () => {
    expect(() => gameDate(-1)).toThrow(RangeError);
    expect(() => gameDate(1.5)).toThrow(RangeError);
  });
});

describe('耗时表', () => {
  it('与设计一致', () => {
    expect(ACTION_MINUTES).toEqual({ cultivate: 60, rest: 120, breakthrough: 180, greet: 10, quest: 10, none: 0 });
  });
  it('移动耗时来自连线；不相邻为 null', () => {
    expect(moveMinutes('loc_qingyun_gate', 'loc_qingyun_yard')).toBe(30);
    expect(moveMinutes('loc_foot_town', 'loc_foot_path')).toBe(60);
    expect(moveMinutes('loc_qingyun_gate', 'loc_foot_town')).toBeNull();
    for (const l of LOCATION_LINKS) expect(l.minutes).toBeGreaterThan(0);
  });
  it('放置修炼：现实 1 小时 = 1 时辰；上限 12 现实小时 = 1 天', () => {
    expect(idleGameMinutes(60, IDLE_CULTIVATION.gameMinutesPerTick)).toBe(MINUTES_PER_SHICHEN);
    const capTicks = OFFLINE.capMs / IDLE_CULTIVATION.tickMs;
    expect(idleGameMinutes(capTicks, IDLE_CULTIVATION.gameMinutesPerTick)).toBe(MINUTES_PER_DAY);
    expect(MAX_ADVANCE_MINUTES).toBeGreaterThanOrEqual(MINUTES_PER_DAY);
  });
});

describe('时长描述', () => {
  it.each([
    [0, '不足 1 分钟'],
    [45, '45 分钟'],
    [60, '1 小时'],
    [90, '1 小时 30 分钟'],
    [1440, '1 天'],
    [1440 + 6 * 60 + 30, '1 天 6 小时'],
  ])('%i 分钟 → %s', (m, text) => {
    expect(formatGameDuration(m)).toBe(text);
  });
});
