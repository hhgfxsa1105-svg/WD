import { describe, expect, it } from 'vitest';
import {
  LOCATION_DEFS,
  MAX_EVENT_TRANSITIONS_PER_TICK,
  SYSTEM_EVENT_DEFS,
  applyPlayerEffects,
  createInitialPlayer,
  eventEndsAt,
  planSteps,
  type SystemEventDef,
} from '../src/index.js';

const def: SystemEventDef = {
  id: 'evt_t',
  title: 't',
  locationId: null,
  startAt: 1000,
  windowMinutes: 100,
  rumorLeadMinutes: 120,
  rumor: 'r',
  opening: 'o',
  join: { minutes: 10, narrative: 'n', effects: [], news: 'x' },
  resolved: 'y',
  worldEffects: [],
};
const instant: SystemEventDef = { ...def, id: 'evt_i', join: null, windowMinutes: 0 };
const fresh = { state: 'scheduled', rumored: false } as const;

describe('事件定义表', () => {
  it('ID 唯一且格式正确，按开始时间排序', () => {
    const ids = SYSTEM_EVENT_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^evt_[a-z0-9_]+$/);
    const starts = SYSTEM_EVENT_DEFS.map((d) => d.startAt);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
  it('地点存在；时间合法；无参与环节的事件窗口为 0；有参与环节的窗口 > 0', () => {
    for (const d of SYSTEM_EVENT_DEFS) {
      if (d.locationId) expect(Object.hasOwn(LOCATION_DEFS, d.locationId), d.id).toBe(true);
      expect(Number.isInteger(d.startAt) && d.startAt >= d.rumorLeadMinutes, d.id).toBe(true);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.rumor.length).toBeGreaterThan(0);
      expect(d.resolved.length).toBeGreaterThan(0);
      if (d.join) {
        expect(d.windowMinutes, d.id).toBeGreaterThan(0);
        expect(d.join.minutes, d.id).toBeGreaterThan(0);
        expect(d.locationId, `${d.id} 有参与环节必须有地点`).not.toBeNull();
        expect(d.opening.length).toBeGreaterThan(0);
      } else expect(d.windowMinutes, d.id).toBe(0);
      for (const w of d.worldEffects) {
        expect(Object.hasOwn(LOCATION_DEFS, w.locationId), d.id).toBe(true);
        expect((w.status === 'blocked') === !!w.reason, `${d.id} 封锁需要原因，开放不能有`).toBe(true);
      }
    }
  });
  it('传闻比开始早；玩家奖励很小', () => {
    for (const d of SYSTEM_EVENT_DEFS) {
      expect(d.rumorLeadMinutes).toBeGreaterThan(0);
      for (const e of d.join?.effects ?? []) expect(Math.abs(e.delta)).toBeLessThanOrEqual(50);
    }
  });
  it('单次调度上限是有限正数', () => {
    expect(MAX_EVENT_TRANSITIONS_PER_TICK).toBeGreaterThan(0);
  });
});

describe('planSteps', () => {
  it('还没到传闻时间：什么都不发生', () => {
    expect(planSteps(def, fresh, def.startAt - def.rumorLeadMinutes - 1)).toEqual([]);
  });
  it('传闻时间到：放出传闻，仍是 scheduled', () => {
    expect(planSteps(def, fresh, def.startAt - def.rumorLeadMinutes)).toEqual([{ kind: 'rumor', late: false }]);
    expect(planSteps(def, { state: 'scheduled', rumored: true }, def.startAt - 1)).toEqual([]);
  });
  it('开始：进入 open；窗口内保持', () => {
    expect(planSteps(def, { state: 'scheduled', rumored: true }, def.startAt)).toEqual([{ kind: 'open' }]);
    expect(planSteps(def, { state: 'open', rumored: true }, def.startAt + 99)).toEqual([]);
  });
  it('窗口恰好结束：close（边界）', () => {
    expect(eventEndsAt(def)).toBe(1100);
    expect(planSteps(def, { state: 'open', rumored: true }, 1099)).toEqual([]);
    expect(planSteps(def, { state: 'open', rumored: true }, 1100)).toEqual([{ kind: 'close' }]);
  });
  it('无参与环节：到点直接 close', () => {
    expect(planSteps(instant, { state: 'scheduled', rumored: true }, instant.startAt)).toEqual([{ kind: 'close' }]);
  });
  it('一次跨过整个事件：传闻不再补发（late），依次 open → close，每步一次', () => {
    expect(planSteps(def, fresh, 5000)).toEqual([{ kind: 'rumor', late: true }, { kind: 'open' }, { kind: 'close' }]);
    expect(planSteps(instant, fresh, 5000)).toEqual([{ kind: 'rumor', late: true }, { kind: 'close' }]);
  });
  it('已了结的事件不再有任何转换（去重）', () => {
    for (const state of ['resolved', 'missed'] as const) expect(planSteps(def, { state, rumored: true }, 9_999_999)).toEqual([]);
  });
});

describe('applyPlayerEffects', () => {
  it('进度封顶 100；铜钱增加；返回实际变化', () => {
    const p = { ...createInitialPlayer(), realmProgress: 98 };
    const r = applyPlayerEffects(p, [{ stat: 'realmProgress', delta: 4 }, { stat: 'copper', delta: 30 }]);
    expect(r.player.realmProgress).toBe(100);
    expect(r.player.currency.copper).toBe(p.currency.copper + 30);
    expect(r.changes).toEqual([{ stat: 'realmProgress', delta: 2 }, { stat: 'copper', delta: 30 }]);
    expect(p.realmProgress).toBe(98); // 不修改入参
  });
  it('没有实际变化时不产生变化记录', () => {
    const p = { ...createInitialPlayer(), realmProgress: 100 };
    expect(applyPlayerEffects(p, [{ stat: 'realmProgress', delta: 4 }]).changes).toEqual([]);
  });
  it('不会减到负数', () => {
    const p = { ...createInitialPlayer(), currency: { yuanbao: 0, silver: 0, copper: 5 } };
    expect(applyPlayerEffects(p, [{ stat: 'copper', delta: -50 }]).player.currency.copper).toBe(0);
  });
});
