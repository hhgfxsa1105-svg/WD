import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { CultivationResponseSchema, ErrorResponseSchema, JoinEventResponseSchema, NewsResponseSchema, WorldEventsResponseSchema, WorldMapResponseSchema, type PlayerState } from '@jhz/contracts';
import {
  INITIAL_GAME_MINUTES,
  IDLE_CULTIVATION,
  MAX_EVENT_TRANSITIONS_PER_TICK,
  SYSTEM_EVENT_DEFS,
  createInitialPlayer,
  fixedRng,
  type SystemEventDef,
} from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { DB_WORLD_EVENT_STATES } from '../src/db/schema.js';
import { importSave } from '../src/modules/player/import.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { snapshotWorld } from '../src/modules/store/world-rules.js';
import { tickWorld } from '../src/modules/world-events/service.js';

const T0 = 1_800_000_000_000;
const MIN = IDLE_CULTIVATION.tickMs;
const CLASS = 'evt_morning_class';
const REPAIR = 'evt_library_repair';
const MARKET = 'evt_town_market';
const REOPEN = 'evt_library_reopen';
const def = (id: string) => SYSTEM_EVENT_DEFS.find((d) => d.id === id)!;
const YARD = 'loc_qingyun_yard';
const LIBRARY = 'loc_qingyun_library';

const fresh = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return d;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
  return 'OK';
};
const stores = (): [string, () => GameStore][] => [
  ['内存', () => createMemoryGameStore(createInitialPlayer())],
  ['SQLite', () => createSqliteGameStore(fresh().db, createInitialPlayer())],
];

describe('数据库约束（world_events / news）', () => {
  it('枚举与契约一致', () => {
    expect([...DB_WORLD_EVENT_STATES]).toEqual(['scheduled', 'open', 'resolved', 'missed']);
  });
  const insert = (d: ReturnType<typeof fresh>, over: Record<string, unknown>) =>
    d.sqlite.prepare('insert into world_events (id, state, rumored, participated, resolved_at) values (@id,@state,@rumored,@participated,@resolved_at)').run({ id: 'evt_x', state: 'scheduled', rumored: 0, participated: 0, resolved_at: null, ...over });
  it.each([
    ['ID 格式', { id: 'x1' }],
    ['状态非法', { state: 'done' }],
    ['布尔非 0/1', { rumored: 2 }],
    ['了结却没有时间', { state: 'resolved' }],
    ['没了结却有时间', { state: 'open', resolved_at: 5 }],
    ['时间为负', { state: 'missed', resolved_at: -1 }],
    ['参加了却不是 resolved', { state: 'missed', resolved_at: 5, participated: 1 }],
  ])('拒绝：%s', (_n, over) => {
    const d = fresh();
    expect(code(() => insert(d, over))).toBe('SQLITE_CONSTRAINT_CHECK');
    d.close();
  });
  it('新闻：同一事件同一种类只能有一条；种类/长度/时间受约束；删除事件级联删除新闻', () => {
    const d = fresh();
    createSqliteGameStore(d.db);
    const add = (over: Record<string, unknown>) =>
      d.sqlite.prepare('insert into news (id, event_id, kind, text, game_minutes, participated) values (@id,@event_id,@kind,@text,@game_minutes,@participated)').run({ id: 'n1', event_id: CLASS, kind: 'rumor', text: '风声', game_minutes: 1, participated: 0, ...over });
    expect(code(() => add({}))).toBe('OK');
    expect(code(() => add({ id: 'n2' }))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(code(() => add({ id: 'n3', kind: 'gossip' }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'n4', kind: 'news', text: '' }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'n5', kind: 'news', text: 'x'.repeat(401) }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'n6', kind: 'news', game_minutes: -1 }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'n7', event_id: 'evt_nope', kind: 'news' }))).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    d.sqlite.pragma('foreign_keys = ON');
    d.sqlite.prepare('delete from world_events where id = ?').run(CLASS);
    expect((d.sqlite.prepare('select count(*) c from news').get() as { c: number }).c).toBe(0);
    d.close();
  });
});

describe.each(stores())('世界事件存取（%s存档）', (_n, make) => {
  it('初始：静态时间线里的每个事件都是 scheduled、未传闻、没有新闻；种子重复执行不覆盖', () => {
    const s = make();
    const rows = s.read((tx) => tx.worldEvents());
    expect(rows.map((r) => r.id).sort()).toEqual(SYSTEM_EVENT_DEFS.map((d) => d.id).sort());
    expect(rows.every((r) => r.state === 'scheduled' && !r.rumored && !r.participated && r.resolvedAt === null)).toBe(true);
    expect(s.read((tx) => tx.news())).toEqual([]);
  });
  it('状态只能向前；了结后不可再变；了结必须带时间；传闻不能收回', () => {
    const s = make();
    const up = (patch: object) => code(() => s.transact((tx) => tx.updateWorldEvent(CLASS, patch)));
    expect(up({ state: 'resolved' })).toBe('VALIDATION_FAILED'); // 没有了结时间
    expect(up({ state: 'open' })).toBe('OK');
    expect(up({ state: 'scheduled' })).toBe('PRECONDITION_FAILED');
    expect(up({ rumored: true })).toBe('OK');
    expect(up({ rumored: false })).toBe('PRECONDITION_FAILED');
    expect(up({ state: 'missed', resolvedAt: 10 })).toBe('OK');
    expect(up({ state: 'open', resolvedAt: null })).toBe('PRECONDITION_FAILED');
    expect(up({ state: 'resolved', resolvedAt: 11 })).toBe('PRECONDITION_FAILED');
    expect(code(() => s.transact((tx) => tx.updateWorldEvent('evt_nope', { rumored: true })))).toBe('NOT_FOUND');
  });
  it('新闻：重复（事件+种类）CONFLICT，未知事件 NOT_FOUND；limit 取最近几条；回滚', () => {
    const s = make();
    const add = (id: string, kind: 'rumor' | 'news') => s.transact((tx) => tx.addNews({ eventId: id, kind, text: `${id}-${kind}`, gameMinutes: 5, participated: false }));
    add(CLASS, 'rumor');
    add(REPAIR, 'rumor');
    add(CLASS, 'news');
    expect(code(() => add(CLASS, 'rumor'))).toBe('CONFLICT');
    expect(code(() => add('evt_nope', 'news'))).toBe('NOT_FOUND');
    expect(s.read((tx) => tx.news()).map((n) => n.text)).toEqual([`${CLASS}-rumor`, `${REPAIR}-rumor`, `${CLASS}-news`]);
    expect(s.read((tx) => tx.news(2)).map((n) => n.text)).toEqual([`${REPAIR}-rumor`, `${CLASS}-news`]);
    expect(() =>
      s.transact((tx) => {
        tx.addNews({ eventId: MARKET, kind: 'rumor', text: 'x', gameMinutes: 1, participated: false });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.read((tx) => tx.news()).length).toBe(3);
  });
});

async function game(opts: { player?: Partial<PlayerState> } = {}) {
  const store = createMemoryGameStore({ ...createInitialPlayer(), ...opts.player });
  const app = await buildApp({ store, clock: { now: () => T0 }, rng: fixedRng(0) });
  const t = () => store.read((tx) => tx.gameMinutes());
  /** 模拟时间流逝到某个游戏时刻（相当于离线回来的一次性折算）并调度世界事件 */
  const goto = (minutes: number) => {
    store.transact((tx) => {
      for (let delta = minutes - tx.gameMinutes(); delta > 0; delta = minutes - tx.gameMinutes()) tx.advanceGameClock(Math.min(delta, 2880));
      return tickWorld(tx, { at: T0, actionId: null });
    });
  };
  const get = async <T>(path: string, schema: { parse(x: unknown): T }) => schema.parse((await app.inject({ method: 'GET', url: `/api/v1/world/${path}` })).json());
  const events = () => get('events', WorldEventsResponseSchema).then((r) => r.events);
  const news = () => get('news', NewsResponseSchema).then((r) => r.news);
  const join = (id: string) => app.inject({ method: 'POST', url: `/api/v1/world/events/${id}/join` });
  const state = (id: string) => store.read((tx) => tx.worldEvents().find((e) => e.id === id)!);
  const moveTo = (id: string) => store.transact((tx) => tx.savePlayer({ ...tx.player(), location: { id, name: id } }));
  return { store, app, t, goto, events, news, join, state, get, moveTo };
}

describe('时间线：传闻 → 开始 → 了结', () => {
  it('还没有风声：事件与新闻都不可见', async () => {
    const g = await game();
    expect(await g.events()).toEqual([]);
    expect(await g.news()).toEqual([]);
  });
  it('传闻时间到：放出传闻（不透露名字与地点），仍是 scheduled；重复调度不重复放出', async () => {
    const g = await game();
    g.goto(def(CLASS).startAt - def(CLASS).rumorLeadMinutes - 1);
    expect(await g.news()).toEqual([]);
    g.goto(def(CLASS).startAt - def(CLASS).rumorLeadMinutes);
    const [ev] = await g.events();
    expect(ev).toMatchObject({ id: CLASS, state: 'scheduled', title: null, location: null, canJoin: false, summary: def(CLASS).rumor });
    expect(ev!.startsAt.label).toBe('第 2 天 · 辰时');
    expect((await g.news()).map((n) => [n.kind, n.eventId])).toEqual([['rumor', CLASS]]);
    g.goto(def(CLASS).startAt - 1);
    g.goto(def(CLASS).startAt - 1);
    expect(await g.news()).toHaveLength(1);
  });
  it('开始：进入 open，给出名字、地点、窗口结束时间；人不在现场时说明原因', async () => {
    const g = await game();
    g.goto(def(CLASS).startAt);
    const [ev] = await g.events();
    expect(ev).toMatchObject({ state: 'open', title: '练功场晨课', location: { id: YARD }, canJoin: false, joinBlockedReason: expect.stringContaining('不在现场') });
    expect(ev!.closesAt!.minutes).toBe(def(CLASS).startAt + def(CLASS).windowMinutes);
  });
  it('窗口内到场参加：小额奖励、耗时、事件了结（resolved）、新闻里包含玩家', async () => {
    const g = await game();
    g.goto(def(CLASS).startAt);
    g.moveTo(YARD);
    const before = g.store.read((tx) => tx.player());
    const t0 = g.t();
    const res = await g.join(CLASS);
    expect(res.statusCode).toBe(200);
    const body = JoinEventResponseSchema.parse(res.json());
    expect(body.changes).toEqual([{ stat: 'realmProgress', delta: 4 }]);
    expect(body.player.realmProgress).toBe(before.realmProgress + 4);
    expect(body.event).toMatchObject({ state: 'resolved', participated: true, canJoin: false });
    expect(g.t()).toBe(t0 + def(CLASS).join!.minutes);
    expect(g.state(CLASS)).toMatchObject({ state: 'resolved', participated: true, resolvedAt: t0 + 60 });
    expect((await g.news()).find((n) => n.kind === 'news')).toMatchObject({ participated: true, text: def(CLASS).join!.news });
    // 再来一次：已经参加过
    const again = await g.join(CLASS);
    expect(again.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(again.json()).message).toContain('已经参加');
    // 窗口过去也不会再变成 missed（去重）
    g.goto(def(CLASS).startAt + 500);
    expect(g.state(CLASS).state).toBe('resolved');
    expect((await g.news()).filter((n) => n.eventId === CLASS && n.kind === 'news')).toHaveLength(1);
  });
  it('参加的前置条件：不在现场 / 还没开始 / 没有风声 / 无法参与 / 窗口已过 / 未知事件，状态都不变', async () => {
    const g = await game();
    const snapshot = () => JSON.stringify([g.store.read((tx) => tx.player()), g.store.read((tx) => tx.worldEvents()), g.t(), g.store.read((tx) => tx.news())]);
    expect((await g.join(CLASS)).statusCode).toBe(404); // 还没有风声
    g.goto(def(CLASS).startAt - 60);
    const s0 = snapshot();
    expect((await g.join(CLASS)).statusCode).toBe(422); // 传闻阶段，还没到时候
    g.goto(def(CLASS).startAt);
    const s1 = snapshot();
    const away = await g.join(CLASS);
    expect(away.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(away.json()).message).toContain('不在现场');
    expect(snapshot()).toBe(s1);
    expect(s0).not.toBe(s1);
    expect((await g.join('evt_nope')).statusCode).toBe(404);
    expect((await g.join('bad-id')).statusCode).toBe(404);
    g.goto(def(REPAIR).startAt - 60); // 藏经阁整修已放出风声，但这件事轮不到玩家插手
    g.goto(def(REPAIR).startAt);
    expect((await g.join(REPAIR)).statusCode).toBe(422);
    // 晨课窗口已过
    g.moveTo(YARD);
    const late = await g.join(CLASS);
    expect(late.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(late.json()).message).toContain('已经过去');
  });
  it('错过窗口：规则自行了结（missed），新闻不含玩家；窗口恰好结束的边界', async () => {
    const g = await game();
    g.goto(def(CLASS).startAt + def(CLASS).windowMinutes - 1);
    expect(g.state(CLASS).state).toBe('open');
    g.goto(def(CLASS).startAt + def(CLASS).windowMinutes);
    expect(g.state(CLASS)).toMatchObject({ state: 'missed', participated: false, resolvedAt: def(CLASS).startAt + def(CLASS).windowMinutes });
    const n = (await g.news()).find((x) => x.kind === 'news' && x.eventId === CLASS)!;
    expect(n).toMatchObject({ participated: false, text: def(CLASS).resolved });
    const [ev] = await g.events();
    expect(ev).toMatchObject({ state: 'missed', participated: false, canJoin: false, closesAt: null });
  });
});

describe('世界效果：共享状态', () => {
  it('藏经阁整修：到点封锁并写明原因（地图可见），重开后恢复；封锁不依赖玩家', async () => {
    const g = await game();
    g.goto(def(REPAIR).startAt);
    expect(g.store.read((tx) => tx.locations().find((l) => l.id === LIBRARY))).toMatchObject({ status: 'blocked', reason: '整修中，暂不开放' });
    g.moveTo(YARD);
    const move = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-move-0001', kind: 'move', locationId: LIBRARY } });
    expect(move.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(move.json()).message).toContain('整修中');
    const map = WorldMapResponseSchema.parse((await g.app.inject({ method: 'GET', url: '/api/v1/world/map' })).json());
    expect(map.exits.find((x) => x.id === LIBRARY)).toMatchObject({ status: 'blocked', reason: '整修中，暂不开放' });
    g.goto(def(REOPEN).startAt);
    expect(g.store.read((tx) => tx.locations().find((l) => l.id === LIBRARY))).toMatchObject({ status: 'open', reason: null });
  });
  it('玩家恰好在被封锁的地点里：仍可离开', async () => {
    const g = await game();
    g.moveTo(LIBRARY);
    g.goto(def(REPAIR).startAt);
    const leave = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-leave-0001', kind: 'move', locationId: YARD } });
    expect(leave.statusCode).toBe(200);
  });
});

describe('大跨度推进与调度上限', () => {
  it('一次跨过全部事件：每个事件只发生一次，按开始时间依次处理，错过的传闻不补发', async () => {
    const g = await game();
    g.goto(def(MARKET).startAt + def(MARKET).windowMinutes + 10); // 集市窗口结束之后；黑风寨事件链从第 4 天才开始，这里不涉及
    expect([CLASS, REPAIR, MARKET, REOPEN].map((id) => g.state(id).state)).toEqual(['missed', 'resolved', 'missed', 'resolved']);
    const ns = await g.news();
    expect(ns.filter((n) => n.kind === 'rumor')).toHaveLength(0);
    expect(ns.filter((n) => n.kind === 'news')).toHaveLength(4);
    // 审计里的事件按开始时间先后：先晨课，再整修，再集市，再重开
    const order = g.store.read((tx) => tx.recentLog(50)).filter((l) => l.type === 'system').map((l) => l.narrative);
    expect(order).toEqual([def(CLASS).resolved, def(REPAIR).resolved, def(MARKET).resolved, def(REOPEN).resolved]);
    expect(g.store.read((tx) => tx.locations().find((l) => l.id === LIBRARY))!.status).toBe('open'); // 先封后开，最终开放
    // 再调度也没有新变化
    g.goto(def(MARKET).startAt + def(MARKET).windowMinutes + 20);
    expect(await g.news()).toHaveLength(4);
  });
  it('单次调度上限：超出的留到下一次，最终全部处理且每个事件只处理一次', async () => {
    const store = createMemoryGameStore(createInitialPlayer());
    const defs: SystemEventDef[] = Array.from({ length: 120 }, (_, i) => ({
      ...def(REPAIR),
      id: `evt_bulk_${String(i).padStart(3, '0')}`,
      startAt: 1000 + i,
      worldEffects: [],
      resolved: `事件 ${i}`,
    }));
    store.transact((tx) => tx.advanceGameClock(2000 - INITIAL_GAME_MINUTES));
    const sizes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const done = store.transact((tx) => tickWorld(tx, { at: T0, actionId: null, defs }));
      sizes.push(done);
      if (done === 0) break;
    }
    expect(sizes[0]).toBe(MAX_EVENT_TRANSITIONS_PER_TICK);
    expect(sizes.every((s) => s <= MAX_EVENT_TRANSITIONS_PER_TICK)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(240); // 每个事件 2 步：补记传闻标记 + 了结
    const rows = store.read((tx) => tx.worldEvents()).filter((e) => e.id.startsWith('evt_bulk_'));
    expect(rows).toHaveLength(120);
    expect(rows.every((r) => r.state === 'resolved')).toBe(true);
    expect(store.read((tx) => tx.news()).filter((n) => n.eventId.startsWith('evt_bulk_'))).toHaveLength(120);
  });
});

describe('由真实的时间推进触发', () => {
  it('行动：休息把时间推过传闻点，当次行动的后果里出现传闻日志', async () => {
    const g = await game();
    g.store.transact((tx) => tx.advanceGameClock(def(CLASS).startAt - def(CLASS).rumorLeadMinutes - tx.gameMinutes() - 60));
    expect(await g.news()).toHaveLength(0);
    const r = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-rest-0001', kind: 'fixed', actionId: 'rest' } });
    expect(r.statusCode).toBe(200);
    expect((await g.news()).map((n) => n.kind)).toEqual(['rumor']);
    const log = g.store.read((tx) => tx.recentLog(5));
    expect(log.map((l) => l.note)).toContain('传闻');
    // 同一个幂等键重放：不再推进、不再产生新闻
    await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-rest-0001', kind: 'fixed', actionId: 'rest' } });
    expect(await g.news()).toHaveLength(1);
  });
  it('被拒绝的行动不推进时间，也不触发事件', async () => {
    const g = await game({ player: { stamina: 0 } });
    g.store.transact((tx) => tx.advanceGameClock(def(CLASS).startAt - 30 - tx.gameMinutes()));
    const r = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-fail-0001', kind: 'fixed', actionId: 'cultivate' } });
    expect(r.statusCode).toBe(422);
    expect(g.state(CLASS)).toMatchObject({ state: 'scheduled', rumored: false });
  });
  it('离线挂机回来：折算的一整天里到期的事件都发生了', async () => {
    const store = createMemoryGameStore(createInitialPlayer());
    const time = { t: T0 };
    const app = await buildApp({ store, clock: { now: () => time.t }, offline: {} });
    const call = async (p: string) => CultivationResponseSchema.parse((await app.inject({ method: 'POST', url: `/api/v1/cultivation${p}` })).json());
    // 游戏时间先走到第 2 天凌晨，再挂机离线 12 小时 → 跨过晨课
    store.transact((tx) => tx.advanceGameClock(1440 + 300 - tx.gameMinutes()));
    await call('/start');
    time.t += 12 * 60 * MIN;
    await call('/settle');
    expect(store.read((tx) => tx.gameMinutes())).toBe(1440 + 300 + 1440);
    const after = store.read((tx) => tx.worldEvents());
    expect(after.find((e) => e.id === CLASS)!.state).toBe('missed');
    expect(after.find((e) => e.id === REPAIR)!.state).toBe('resolved');
    expect(store.read((tx) => tx.news()).length).toBeGreaterThan(0);
  });
  it('打招呼的耗时同样触发事件', async () => {
    const g = await game();
    g.store.transact((tx) => tx.advanceGameClock(def(CLASS).startAt - def(CLASS).rumorLeadMinutes - 5 - tx.gameMinutes()));
    expect(await g.news()).toHaveLength(0);
    expect((await g.app.inject({ method: 'POST', url: '/api/v1/world/npcs/npc_gate_guard/greet' })).statusCode).toBe(200); // 耗时 10 分钟，越过传闻点
    expect((await g.news()).map((n) => n.kind)).toEqual(['rumor']);
  });
});

describe('审计：事件相关的每个变更都有可重放的差异', () => {
  it('晨课（参加）、整修（封锁）、集市（错过）、重开：按序重放全部审计差异 = 最终状态', async () => {
    const d = fresh();
    const store = createSqliteGameStore(d.db, createInitialPlayer());
    const app = await buildApp({ store, clock: { now: () => T0 }, rng: fixedRng(0) });
    const { snapshot } = await import('../src/modules/audit/diff.js');
    type Snap = Record<string, unknown>;
    const NESTED = ['inventory', 'npcs', 'relations', 'memories', 'quests', 'locations', 'worldEvents', 'factions', 'factionRelations', 'personalEvents'];
    const initial = store.read((tx) => snapshot(tx)) as Snap;
    const tick = (to: number) =>
      store.transact((tx) => {
        for (let dl = to - tx.gameMinutes(); dl > 0; dl = to - tx.gameMinutes()) tx.advanceGameClock(Math.min(dl, 2880));
        tickWorld(tx, { at: T0, actionId: null });
      });
    tick(def(CLASS).startAt - 60); // 传闻
    tick(def(CLASS).startAt);
    expect((await app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'we-audit-0001', kind: 'move', locationId: YARD } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/world/events/${CLASS}/join` })).statusCode).toBe(200);
    tick(def(MARKET).startAt - 30);
    tick(def(REOPEN).startAt + 10);
    const final = store.read((tx) => snapshot(tx)) as Snap;

    const cur: Snap = structuredClone(initial);
    const rows = d.sqlite.prepare('select seq, event_type, before_json, after_json from audit_events order by seq').all() as { seq: number; event_type: string; before_json: string | null; after_json: string | null }[];
    expect(rows.filter((r) => r.event_type.startsWith('world.event.')).length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      const before = (r.before_json ? JSON.parse(r.before_json) : {}) as Snap;
      const after = (r.after_json ? JSON.parse(r.after_json) : {}) as Snap;
      if ('gameMinutes' in before) cur.gameMinutes = before.gameMinutes; // 测试里手工推进时钟（真实流程中时钟由已审计的行动推进）
      for (const k of Object.keys(before)) {
        if (NESTED.includes(k)) for (const id of Object.keys(before[k] as object)) expect(((cur[k] ?? {}) as Snap)[id], `事件 ${r.seq}(${r.event_type}) 前值 ${k}.${id}`).toEqual((before[k] as Snap)[id]);
        else expect(cur[k], `事件 ${r.seq}(${r.event_type}) 前值 ${k}`).toEqual(before[k]);
      }
      for (const k of Object.keys(after)) {
        if (NESTED.includes(k)) Object.assign((cur[k] ??= {}) as Snap, after[k]);
        else cur[k] = after[k];
      }
    }
    for (const k of Object.keys(final)) {
      if (k === 'gameMinutes') continue;
      expect(JSON.stringify(cur[k]), `字段 ${k}`).toBe(JSON.stringify(final[k]));
    }
    d.close();
  });
});

describe('接口', () => {
  it('新闻最新在前，limit 受限；写方法不存在', async () => {
    const g = await game();
    g.goto(def(CLASS).startAt - 60);
    g.goto(def(REPAIR).startAt - 60);
    const ns = await g.news();
    expect(ns.map((n) => `${n.eventId}:${n.kind}`)).toEqual([`${REPAIR}:rumor`, `${CLASS}:news`, `${CLASS}:rumor`]);
    expect(((await g.app.inject({ method: 'GET', url: '/api/v1/world/news?limit=1' })).json() as { news: unknown[] }).news).toHaveLength(1);
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/world/news?limit=0' })).statusCode).toBe(400);
    expect((await g.app.inject({ method: 'GET', url: '/api/v1/world/news?x=1' })).statusCode).toBe(400);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await g.app.inject({ method, url: '/api/v1/world/news', payload: {} })).statusCode, method).toBe(404);
      expect((await g.app.inject({ method, url: '/api/v1/world/events', payload: {} })).statusCode, method).toBe(404);
    }
    expect((await g.app.inject({ method: 'GET', url: `/api/v1/world/events/${CLASS}/join` })).statusCode).toBe(404);
  });
});

describe('存档', () => {
  const sqliteGame = () => {
    const d = fresh();
    return { d, s: createSqliteGameStore(d.db, createInitialPlayer()) };
  };
  const exportRaw = (s: GameStore) => JSON.parse(JSON.stringify(s.read((tx) => buildSaveFile(tx.player(), snapshotWorld(tx)))));
  const play = (s: GameStore, to: number) =>
    s.transact((tx) => {
      tx.advanceGameClock(to - tx.gameMinutes());
      tickWorld(tx, { at: T0, actionId: null });
    });

  it('往返：事件状态、传闻与新闻、被封锁的地点、游戏时间原样恢复', () => {
    const a = sqliteGame();
    play(a.s, def(CLASS).startAt - 60); // 传闻
    play(a.s, def(REPAIR).startAt + 1); // 晨课错过 + 整修封锁
    const raw = exportRaw(a.s);
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.worldEvents())).toEqual(a.s.read((tx) => tx.worldEvents()));
    expect(b.s.read((tx) => tx.news())).toEqual(a.s.read((tx) => tx.news()));
    expect(b.s.read((tx) => tx.locations())).toEqual(a.s.read((tx) => tx.locations()));
    expect(b.s.read((tx) => tx.gameMinutes())).toBe(a.s.read((tx) => tx.gameMinutes()));
    // 导入后继续：重开藏经阁，已了结的事件不会重复
    play(b.s, def(REOPEN).startAt);
    expect(b.s.read((tx) => tx.locations().find((l) => l.id === LIBRARY))!.status).toBe('open');
    expect(b.s.read((tx) => tx.news()).filter((n) => n.eventId === CLASS)).toHaveLength(2);
  });
  it('旧存档（没有事件）：全部初始、没有消息，导入覆盖原有状态', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    delete raw.world.events;
    delete raw.world.news;
    const b = sqliteGame();
    play(b.s, def(REPAIR).startAt + 1);
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.worldEvents()).every((e) => e.state === 'scheduled')).toBe(true);
    expect(b.s.read((tx) => tx.news())).toEqual([]);
  });
  it.each([
    ['未知事件', (r: { world: { events: unknown[] } }) => (r.world.events = [{ id: 'evt_unknown', state: 'scheduled', rumored: false, participated: false, resolvedAt: null }])],
    ['事件重复', (r: { world: { events: unknown[] } }) => (r.world.events = [{ id: CLASS, state: 'scheduled', rumored: false, participated: false, resolvedAt: null }, { id: CLASS, state: 'open', rumored: true, participated: false, resolvedAt: null }])],
    ['新闻指向未知事件', (r: { world: { news: unknown[] } }) => (r.world.news = [{ id: 'n1', eventId: 'evt_unknown', kind: 'rumor', text: 'x', gameMinutes: 1, participated: false }])],
    ['同一事件的新闻重复', (r: { world: { news: unknown[] } }) => (r.world.news = [{ id: 'n1', eventId: CLASS, kind: 'rumor', text: 'x', gameMinutes: 1, participated: false }, { id: 'n2', eventId: CLASS, kind: 'rumor', text: 'y', gameMinutes: 2, participated: false }])],
    ['事件没了结却有结果新闻', (r: { world: { news: unknown[] } }) => (r.world.news = [{ id: 'n1', eventId: CLASS, kind: 'news', text: 'x', gameMinutes: 1, participated: false }])],
  ])('导入拒绝：%s，目标存档不变', (_n, mutate) => {
    const raw = exportRaw(sqliteGame().s);
    (mutate as (r: unknown) => void)(raw);
    const b = sqliteGame();
    play(b.s, def(CLASS).startAt - 60);
    const before = JSON.stringify([b.s.read((tx) => tx.worldEvents()), b.s.read((tx) => tx.news())]);
    expect(() => importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0)).toThrow();
    expect(JSON.stringify([b.s.read((tx) => tx.worldEvents()), b.s.read((tx) => tx.news())])).toBe(before);
  });
  it.each([
    ['了结却没有时间', { id: CLASS, state: 'missed', rumored: true, participated: false, resolvedAt: null }],
    ['参加了却不是 resolved', { id: CLASS, state: 'missed', rumored: true, participated: true, resolvedAt: 5 }],
    ['未知状态', { id: CLASS, state: 'gone', rumored: true, participated: false, resolvedAt: null }],
  ])('解析拒绝非法事件记录：%s', (_n, bad) => {
    const raw = exportRaw(sqliteGame().s);
    raw.world.events = [bad];
    expect(() => parseSaveFile(JSON.stringify(raw))).toThrow();
  });
});

describe('迁移：带数据升级到世界事件', () => {
  it('旧库升级后有事件表，种子补齐；已有玩家数据不变', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-evt-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const cut = (journal.entries as { tag: string }[]).findIndex((e) => e.tag.includes('world_events'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, cut);
      writeFileSync(journalPath, JSON.stringify(journal));
      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      d.sqlite.prepare("insert into players (id, display_name) values ('player_1', '林惊鸿')").run();
      runMigrations(d.db);
      expect((d.sqlite.prepare('select count(*) c from world_events').get() as { c: number }).c).toBe(0);
      const s = createSqliteGameStore(d.db, createInitialPlayer());
      createSqliteGameStore(d.db); // 重复播种
      expect(s.read((tx) => tx.worldEvents()).map((e) => e.id).sort()).toEqual(SYSTEM_EVENT_DEFS.map((x) => x.id).sort());
      expect((d.sqlite.prepare("select display_name n from players where id='player_1'").get() as { n: string }).n).toBe('林惊鸿');
      d.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
