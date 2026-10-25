import { describe, expect, it } from 'vitest';
import { GRADES, PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import {
  DEFAULT_METHOD_ID,
  ITEM_DEFS,
  METHODS,
  createInitialPlayer,
  isKnownItem,
  pillGradeOf,
  settleIdleCultivation,
  toInventoryItems,
} from '../src/index.js';

const p0 = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createInitialPlayer(), ...patch });
const settle = (p: PlayerState, ticks: number) => settleIdleCultivation(p, DEFAULT_METHOD_ID, ticks);

describe('放置修炼结算', () => {
  it('凡阶 + 头衔 5%：每片 0.21，10 片得 2 点，消耗全部 10 片', () => {
    const r = settle(p0(), 10);
    expect(r.player.realmProgress).toBe(2);
    expect(r.ticksUsed).toBe(10);
    expect(r.changes).toEqual([{ stat: 'realmProgress', delta: 2 }]);
  });

  it('产出不足 1 点时不消耗时间片（零头保留）', () => {
    const r = settle(p0(), 4); // 4 × 0.21 = 0.84
    expect(r.ticksUsed).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.player.realmProgress).toBe(0);
  });

  it('只消耗产出所需的最少时间片', () => {
    const r = settle(p0(), 30); // 6.3 → 6 点；产出 6 点至少需要 ceil(6/0.21)=29 片
    expect(r.player.realmProgress).toBe(6);
    expect(r.ticksUsed).toBe(29);
  });

  it('拆分结算的总收益不超过一次结算（不能靠频繁结算多拿）', () => {
    const once = settle(p0(), 600).player.realmProgress;
    let p = p0();
    let pending = 0;
    for (let i = 0; i < 600; i++) {
      pending += 1;
      const r = settle(p, pending);
      p = r.player;
      pending -= r.ticksUsed;
    }
    expect(p.realmProgress).toBe(once);
  });

  it('功法评级与名号加成：天阶更快（经由 METHODS 表）', () => {
    expect(METHODS[DEFAULT_METHOD_ID]!.grade).toBe('fan');
    const noBonus = p0({ title: null, epithet: null, fate: null });
    expect(settle(noBonus, 50).player.realmProgress).toBe(10); // 0.2 × 50
  });

  it('进度封顶 100 并标记圆满', () => {
    const r = settle(p0({ realmProgress: 99 }), 1000);
    expect(r.player.realmProgress).toBe(100);
    expect(r.completed).toBe(true);
    expect(r.changes).toEqual([{ stat: 'realmProgress', delta: 1 }]);
  });

  it('已圆满时不再产出', () => {
    const r = settle(p0({ realmProgress: 100 }), 1000);
    expect(r.changes).toEqual([]);
    expect(r.ticksUsed).toBe(0);
    expect(r.completed).toBe(true);
  });

  it('炼体无内力；后天起按已消耗时间片获得内力并封顶', () => {
    expect(settle(p0(), 100).player.neili).toBeNull();
    const h = p0({ realm: 'houtian', neili: { current: 0, max: 60 } });
    const r = settle(h, 100);
    expect(r.changes.map((c) => c.stat)).toEqual(['realmProgress', 'neili']);
    expect(r.player.neili!.current).toBeLessThanOrEqual(60);
    const nearFull = settle({ ...h, neili: { current: 59, max: 60 } }, 100);
    expect(nearFull.player.neili).toEqual({ current: 60, max: 60 });
  });

  it('零或负时间片不产生收益，不修改入参', () => {
    const p = p0();
    const snap = JSON.stringify(p);
    expect(settle(p, 0).changes).toEqual([]);
    expect(settle(p, -5).changes).toEqual([]);
    settle(p, 100);
    expect(JSON.stringify(p)).toBe(snap);
  });

  it('未知功法抛错；结果通过契约校验', () => {
    expect(() => settleIdleCultivation(p0(), 'nope', 10)).toThrow();
    expect(PlayerStateSchema.safeParse(settle(p0(), 100).player).success).toBe(true);
  });
});

describe('物品定义', () => {
  it('每个评级一种突破丹，名称与评级对应', () => {
    expect(Object.keys(ITEM_DEFS)).toHaveLength(GRADES.length);
    expect(ITEM_DEFS.pill_breakthrough_tian).toMatchObject({ name: '天阶突破丹', grade: 'tian', kind: 'breakthrough_pill' });
    expect(pillGradeOf('pill_breakthrough_di')).toBe('di');
    expect(pillGradeOf('bogus')).toBeNull();
    expect(isKnownItem('pill_breakthrough_fan')).toBe(true);
    expect(isKnownItem('toString')).toBe(false);
  });

  it('库存条目：过滤 0 数量、排序、未知物品视为存档损坏', () => {
    const items = toInventoryItems([
      { itemId: 'pill_breakthrough_xuan', quantity: 2 },
      { itemId: 'pill_breakthrough_fan', quantity: 0 },
      { itemId: 'pill_breakthrough_huang', quantity: 1 },
    ]);
    expect(items.map((i) => i.itemId)).toEqual(['pill_breakthrough_huang', 'pill_breakthrough_xuan']);
    expect(() => toInventoryItems([{ itemId: 'bogus', quantity: 1 }])).toThrow();
  });
});

describe('收益效率（离线折算）', () => {
  const noBonus = () => p0({ title: null, epithet: null, fate: null });

  it('效率 0.5：同样时间片的进度减半，所需时间片翻倍', () => {
    const full = settleIdleCultivation(noBonus(), DEFAULT_METHOD_ID, 100, 1); // 100 × 0.2 = 20
    const half = settleIdleCultivation(noBonus(), DEFAULT_METHOD_ID, 100, 0.5); // 100 × 0.1 = 10
    expect(full.player.realmProgress).toBe(20);
    expect(half.player.realmProgress).toBe(10);
    expect(half.ticksUsed).toBe(100);
    expect(settleIdleCultivation(noBonus(), DEFAULT_METHOD_ID, 100, 0.5).changes).toEqual([{ stat: 'realmProgress', delta: 10 }]);
  });

  it('效率下不足 1 点不消耗时间片', () => {
    expect(settleIdleCultivation(noBonus(), DEFAULT_METHOD_ID, 9, 0.5).ticksUsed).toBe(0); // 0.9
  });

  it('内力同比折算', () => {
    const h = noBonus();
    h.realm = 'houtian';
    h.neili = { current: 0, max: 600 };
    const full = settleIdleCultivation(h, DEFAULT_METHOD_ID, 100, 1).player.neili!.current; // 100 × 0.5 = 50
    const half = settleIdleCultivation(h, DEFAULT_METHOD_ID, 200, 0.5).player.neili!.current; // 200 × 0.5 × 0.5 = 50
    expect(full).toBe(50);
    expect(half).toBe(50);
  });

  it('默认效率为 1（兼容在线结算）', () => {
    expect(settleIdleCultivation(noBonus(), DEFAULT_METHOD_ID, 100).player.realmProgress).toBe(20);
  });
});
