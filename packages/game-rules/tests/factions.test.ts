import { describe, expect, it } from 'vitest';
import {
  FACTION_DEFS,
  FACTION_IDS,
  INITIAL_FACTION_RELATIONS,
  MAX_FACTION_DELTA,
  SYSTEM_EVENT_DEFS,
  applyFactionEffects,
  attitudeLabel,
  relationKey,
  relationLabel,
  relationPair,
  resolveOutcome,
  strengthLabel,
  type FactionSnapshot,
  type OutcomeContext,
  type SystemEventDef,
} from '../src/index.js';

const initial = (): FactionSnapshot => ({
  factions: Object.fromEntries(FACTION_IDS.map((id) => [id, { strength: FACTION_DEFS[id].strength, attitude: FACTION_DEFS[id].attitude }])),
  relations: Object.fromEntries(INITIAL_FACTION_RELATIONS.map((r) => [`${r.a}|${r.b}`, r.value])),
});

describe('势力定义', () => {
  it('两个演示势力；初始值在范围内；关系对已排序', () => {
    expect(FACTION_IDS).toEqual(['fac_qingyun', 'fac_blackwind']);
    for (const id of FACTION_IDS) {
      expect(id).toMatch(/^fac_[a-z0-9_]+$/);
      expect(FACTION_DEFS[id].strength).toBeGreaterThanOrEqual(0);
      expect(FACTION_DEFS[id].strength).toBeLessThanOrEqual(100);
    }
    for (const r of INITIAL_FACTION_RELATIONS) expect(r.a < r.b).toBe(true);
  });
  it('关系对与方向无关', () => {
    expect(relationPair('fac_b', 'fac_a')).toEqual(['fac_a', 'fac_b']);
    expect(relationKey('fac_qingyun', 'fac_blackwind')).toBe(relationKey('fac_blackwind', 'fac_qingyun'));
  });
});

describe('applyFactionEffects', () => {
  it('改动实力、态度、关系，返回实际变化；不修改入参', () => {
    const s = initial();
    const r = applyFactionEffects(s, [
      { kind: 'strength', faction: 'fac_blackwind', delta: -8 },
      { kind: 'attitude', faction: 'fac_qingyun', delta: 4 },
      { kind: 'relation', a: 'fac_qingyun', b: 'fac_blackwind', delta: -6 },
    ]);
    expect(r.state.factions.fac_blackwind!.strength).toBe(32);
    expect(r.state.factions.fac_qingyun!.attitude).toBe(14);
    expect(r.state.relations['fac_blackwind|fac_qingyun']).toBe(-36);
    expect(r.changes).toEqual([
      { kind: 'strength', faction: 'fac_blackwind', from: 40, to: 32 },
      { kind: 'attitude', faction: 'fac_qingyun', from: 10, to: 14 },
      { kind: 'relation', a: 'fac_blackwind', b: 'fac_qingyun', from: -30, to: -36 },
    ]);
    expect(s.factions.fac_blackwind!.strength).toBe(40);
  });
  it('单次改动限幅 ±20；结果夹回范围；没有实际变化不记录', () => {
    const s = initial();
    const big = applyFactionEffects(s, [{ kind: 'strength', faction: 'fac_qingyun', delta: 999 }]);
    expect(big.state.factions.fac_qingyun!.strength).toBe(80); // 60 + 20
    const cap = applyFactionEffects({ ...s, factions: { ...s.factions, fac_qingyun: { strength: 95, attitude: 10 } } }, [{ kind: 'strength', faction: 'fac_qingyun', delta: 20 }]);
    expect(cap.state.factions.fac_qingyun!.strength).toBe(100);
    const floor = applyFactionEffects({ ...s, factions: { ...s.factions, fac_blackwind: { strength: 3, attitude: 0 } } }, [{ kind: 'strength', faction: 'fac_blackwind', delta: -20 }]);
    expect(floor.state.factions.fac_blackwind!.strength).toBe(0);
    const none = applyFactionEffects({ ...s, factions: { ...s.factions, fac_blackwind: { strength: 0, attitude: 0 } } }, [{ kind: 'strength', faction: 'fac_blackwind', delta: -5 }]);
    expect(none.changes).toEqual([]);
  });
  it('未知势力 / 未知关系抛错', () => {
    expect(() => applyFactionEffects(initial(), [{ kind: 'strength', faction: 'fac_nope' as never, delta: 1 }])).toThrow(RangeError);
    expect(() => applyFactionEffects(initial(), [{ kind: 'relation', a: 'fac_qingyun', b: 'fac_nope' as never, delta: 1 }])).toThrow(RangeError);
  });
  it('随机序列：永远落在合法范围内', () => {
    let s = initial();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 2000; i++) {
      const kind = (['strength', 'attitude', 'relation'] as const)[Math.floor(rnd() * 3)]!;
      const delta = Math.floor(rnd() * 80) - 40;
      const e = kind === 'relation' ? ({ kind, a: 'fac_qingyun', b: 'fac_blackwind', delta } as const) : ({ kind, faction: FACTION_IDS[Math.floor(rnd() * 2)]!, delta } as const);
      s = applyFactionEffects(s, [e]).state;
      for (const f of Object.values(s.factions)) {
        expect(f.strength >= 0 && f.strength <= 100).toBe(true);
        expect(f.attitude >= -100 && f.attitude <= 100).toBe(true);
      }
      for (const v of Object.values(s.relations)) expect(v >= -100 && v <= 100).toBe(true);
    }
  });
});

describe('标签', () => {
  it('覆盖整个范围，边界处切换', () => {
    expect([0, 24, 25, 39, 40, 54, 55, 74, 75, 100].map(strengthLabel)).toEqual(['风雨飘摇', '风雨飘摇', '衰微', '衰微', '势均力敌', '势均力敌', '强盛', '强盛', '如日中天', '如日中天']);
    expect([-100, -50, -49, -15, -14, 14, 15, 49, 50].map(attitudeLabel)).toEqual(['敌视', '敌视', '戒备', '戒备', '观望', '观望', '友善', '友善', '亲近']);
    expect(relationLabel(-30)).toBe('嫌隙');
  });
});

describe('事件链：定义完整性', () => {
  const ids = new Set(SYSTEM_EVENT_DEFS.map((d) => d.id));
  const effectsOf = (d: SystemEventDef) => [...(d.factionEffects ?? []), ...(d.onJoin?.factionEffects ?? []), ...(d.onMiss?.factionEffects ?? []), ...(d.branches ?? []).flatMap((b) => b.factionEffects ?? [])];
  it('势力影响指向存在的势力，单次改动不超过上限', () => {
    for (const d of SYSTEM_EVENT_DEFS)
      for (const e of effectsOf(d)) {
        if (e.kind === 'relation') {
          expect(FACTION_IDS).toContain(e.a);
          expect(FACTION_IDS).toContain(e.b);
        } else expect(FACTION_IDS, d.id).toContain(e.faction);
        expect(Math.abs(e.delta), d.id).toBeLessThanOrEqual(MAX_FACTION_DELTA);
      }
  });
  it('分支只看更早结束的事件，并且指向有参与环节的事件', () => {
    for (const d of SYSTEM_EVENT_DEFS)
      for (const b of d.branches ?? []) {
        const w = b.when;
        if ('event' in w) {
          const dep = SYSTEM_EVENT_DEFS.find((x) => x.id === w.event)!;
          expect(ids.has(dep.id), `${d.id} 引用了不存在的事件`).toBe(true);
          expect(dep.join, `${d.id} 的分支依赖的事件必须有参与环节`).not.toBeNull();
          expect(dep.startAt + dep.windowMinutes, `${d.id} 必须在 ${dep.id} 结束之后开始`).toBeLessThanOrEqual(d.startAt);
        } else expect(FACTION_IDS).toContain(w.faction);
      }
  });
  it('封锁/开放的世界影响写在 onMiss / onJoin / 分支里也满足「封锁必有原因」', () => {
    for (const d of SYSTEM_EVENT_DEFS)
      for (const w of [...d.worldEffects, ...(d.onJoin?.worldEffects ?? []), ...(d.onMiss?.worldEffects ?? []), ...(d.branches ?? []).flatMap((b) => b.worldEffects ?? [])])
        expect((w.status === 'blocked') === !!w.reason, d.id).toBe(true);
  });
  it('链上每次封锁最终都有解封的事件（不会永久封死）', () => {
    const blocked = new Set<string>();
    const opened = new Set<string>();
    for (const d of SYSTEM_EVENT_DEFS)
      for (const w of [...d.worldEffects, ...(d.onJoin?.worldEffects ?? []), ...(d.onMiss?.worldEffects ?? []), ...(d.branches ?? []).flatMap((b) => b.worldEffects ?? [])]) (w.status === 'blocked' ? blocked : opened).add(w.locationId);
    for (const l of blocked) expect(opened.has(l), `${l} 被封锁后没有解封事件`).toBe(true);
  });
});

describe('resolveOutcome（黑风寨之患）', () => {
  const def = (id: string) => SYSTEM_EVENT_DEFS.find((d) => d.id === id)!;
  const ctx = (over: Partial<OutcomeContext> = {}): OutcomeContext => ({ joined: false, events: {}, factionStrength: { fac_qingyun: 60, fac_blackwind: 40 }, ...over });

  it('劫案：参加 → 山贼受挫、不封镇；没参加 → 山贼坐大、封镇', () => {
    const joined = resolveOutcome(def('evt_bandit_raid'), ctx({ joined: true }));
    expect(joined.news).toBe(def('evt_bandit_raid').join!.news);
    expect(joined.worldEffects).toEqual([]);
    expect(joined.factionEffects).toContainEqual({ kind: 'strength', faction: 'fac_blackwind', delta: -8 });
    const missed = resolveOutcome(def('evt_bandit_raid'), ctx());
    expect(missed.news).toBe(def('evt_bandit_raid').resolved);
    expect(missed.worldEffects).toEqual([{ kind: 'location', locationId: 'loc_foot_town', status: 'blocked', reason: '山贼拦路，镇上去不得' }]);
    expect(missed.factionEffects).toContainEqual({ kind: 'strength', faction: 'fac_blackwind', delta: 8 });
  });
  it('议事：结局取决于劫案是否有人出手；前序未了结则用默认', () => {
    const council = def('evt_sect_council');
    const a = resolveOutcome(council, ctx({ events: { evt_bandit_raid: { state: 'resolved', participated: true } } }));
    const b = resolveOutcome(council, ctx({ events: { evt_bandit_raid: { state: 'missed', participated: false } } }));
    const c = resolveOutcome(council, ctx({ events: { evt_bandit_raid: { state: 'open', participated: false } } }));
    expect(a.news).toContain('喝退了山贼');
    expect(b.news).toContain('拦路');
    expect(c.news).toBe(council.resolved);
    expect(a.factionEffects).not.toEqual(b.factionEffects);
  });
  it('来犯：黑风寨实力 ≥ 55 时更凶；其余按基础结果', () => {
    const assault = def('evt_blackwind_assault');
    const strong = resolveOutcome(assault, ctx({ factionStrength: { fac_qingyun: 60, fac_blackwind: 55 } }));
    expect(strong.news).toContain('来势汹汹');
    expect(strong.factionEffects).toContainEqual({ kind: 'strength', faction: 'fac_qingyun', delta: -4 });
    expect(resolveOutcome(assault, ctx({ factionStrength: { fac_qingyun: 60, fac_blackwind: 54 } })).news).toBe(assault.resolved);
  });
  it('风波过后：总是解封小镇；按黑风寨实力三种说法（边界 55 / 30）', () => {
    const after = def('evt_blackwind_aftermath');
    const at = (n: number) => resolveOutcome(after, ctx({ factionStrength: { fac_qingyun: 60, fac_blackwind: n } }));
    for (const n of [10, 40, 80]) expect(at(n).worldEffects).toEqual([{ kind: 'location', locationId: 'loc_foot_town', status: 'open' }]);
    expect(at(55).news).toContain('气焰未消');
    expect(at(54).news).toBe(after.resolved);
    expect(at(31).news).toBe(after.resolved);
    expect(at(30).news).toContain('元气大伤');
  });
  it('确定性：同样的历史永远得到同样的结局', () => {
    const c = ctx({ events: { evt_bandit_raid: { state: 'missed', participated: false } } });
    expect(resolveOutcome(def('evt_sect_council'), c)).toEqual(resolveOutcome(def('evt_sect_council'), structuredClone(c)));
  });
});
