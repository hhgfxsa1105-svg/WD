import { describe, expect, it } from 'vitest';
import { GRADES, REALMS, ATTRIBUTE_KEYS, PlayerStateSchema } from '@jhz/contracts';
import { createInitialPlayer } from '../src/mock/data';
import { cultivate, rest } from '../src/mock/engine';
import { ATTRIBUTE_ORDER, GRADE_LABEL, GRADE_RANK, REALM_LABEL } from '../src/labels';

describe('labels', () => {
  it('覆盖所有境界、评级与六维', () => {
    expect(Object.keys(REALM_LABEL).sort()).toEqual([...REALMS].sort());
    expect(Object.keys(GRADE_LABEL).sort()).toEqual([...GRADES].sort());
    expect(Object.keys(GRADE_RANK).sort()).toEqual([...GRADES].sort());
    expect(ATTRIBUTE_ORDER.map((a) => a.key).sort()).toEqual([...ATTRIBUTE_KEYS].sort());
  });
  it('境界顺序为 炼体→通窍→后天→先天→宗师→明神→陆地神仙', () => {
    expect(REALMS.map((r) => REALM_LABEL[r]).join('→')).toBe('炼体→通窍→后天→先天→宗师→明神→陆地神仙');
  });
});

describe('示例数据与示例结算', () => {
  it('初始角色通过契约校验', () => {
    expect(PlayerStateSchema.safeParse(createInitialPlayer()).success).toBe(true);
  });

  it('炼体修炼：消耗体力、增加进度，无内力变化', () => {
    const r = cultivate(createInitialPlayer())!;
    expect(r.player.stamina).toBe(40);
    expect(r.player.realmProgress).toBe(4);
    expect(r.player.neili).toBeNull();
    expect(r.player.version).toBe(1);
  });

  it('后天修炼：同时增加内力，且不超过上限', () => {
    const base = { ...createInitialPlayer(), realm: 'houtian' as const, neili: { current: 58, max: 60 } };
    const r = cultivate(base)!;
    expect(r.player.neili).toEqual({ current: 60, max: 60 });
  });

  it('体力不足不能修炼', () => {
    expect(cultivate({ ...createInitialPlayer(), stamina: 9 })).toBeNull();
  });

  it('进度与体力不越界', () => {
    let p = { ...createInitialPlayer(), realmProgress: 98 };
    p = cultivate(p)!.player;
    expect(p.realmProgress).toBe(100);
    expect(rest({ ...p, stamina: 49 }).player.stamina).toBe(50);
  });

  it('休息恢复体力与气血，满值不溢出', () => {
    const r = rest({ ...createInitialPlayer(), stamina: 20, hp: 98 });
    expect(r.player.stamina).toBe(35);
    expect(r.player.hp).toBe(100);
  });
});
