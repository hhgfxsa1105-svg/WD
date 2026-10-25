import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema, FactionsResponseSchema } from '@jhz/contracts';
import { FACTION_DEFS, MAX_FACTION_DELTA, SYSTEM_EVENT_DEFS, createInitialPlayer, fixedRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { snapshot } from '../src/modules/audit/diff.js';
import { importSave } from '../src/modules/player/import.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { snapshotWorld } from '../src/modules/store/world-rules.js';
import { tickWorld } from '../src/modules/world-events/service.js';

const T0 = 1_800_000_000_000;
const QY = 'fac_qingyun';
const BW = 'fac_blackwind';
const RAID = 'evt_bandit_raid';
const COUNCIL = 'evt_sect_council';
const ASSAULT = 'evt_blackwind_assault';
const AFTER = 'evt_blackwind_aftermath';
const TOWN = 'loc_foot_town';
const def = (id: string) => SYSTEM_EVENT_DEFS.find((d) => d.id === id)!;

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

describe('数据库约束（factions / faction_relations / faction_history）', () => {
  it.each([
    ['ID 格式', `insert into factions (id, strength, attitude) values ('x1', 10, 0)`],
    ['实力超过 100', `insert into factions (id, strength, attitude) values ('fac_x', 101, 0)`],
    ['实力为负', `insert into factions (id, strength, attitude) values ('fac_x', -1, 0)`],
    ['态度超范围', `insert into factions (id, strength, attitude) values ('fac_x', 10, 101)`],
    ['关系未排序（a ≥ b）', `insert into faction_relations (a, b, value) values ('fac_qingyun', 'fac_blackwind', 0)`],
    ['关系超范围', `insert into faction_relations (a, b, value) values ('fac_a', 'fac_b', 101)`],
  ])('拒绝：%s', (_n, sqlText) => {
    const d = fresh();
    createSqliteGameStore(d.db);
    d.sqlite.pragma('foreign_keys = OFF'); // 只检查 CHECK
    expect(code(() => d.sqlite.prepare(sqlText).run())).toBe('SQLITE_CONSTRAINT_CHECK');
    d.close();
  });
  it('关系的两端必须是已有势力；一对势力只有一行', () => {
    const d = fresh();
    createSqliteGameStore(d.db);
    expect(code(() => d.sqlite.prepare(`insert into faction_relations (a, b, value) values ('fac_blackwind', 'fac_nope', 0)`).run())).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(code(() => d.sqlite.prepare(`insert into faction_relations (a, b, value) values ('fac_blackwind', 'fac_qingyun', 5)`).run())).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
    d.close();
  });
  it('势力历史：每个事件一条；变化必须是 JSON 数组；事件必须存在', () => {
    const d = fresh();
    createSqliteGameStore(d.db);
    const add = (over: Record<string, unknown>) =>
      d.sqlite
        .prepare('insert into faction_history (id, event_id, game_minutes, text, changes_json) values (@id,@event_id,@game_minutes,@text,@changes_json)')
        .run({ id: 'h1', event_id: RAID, game_minutes: 1, text: 'x', changes_json: '[]', ...over });
    expect(code(() => add({}))).toBe('OK');
    expect(code(() => add({ id: 'h2' }))).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(code(() => add({ id: 'h3', event_id: COUNCIL, changes_json: '{}' }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'h4', event_id: COUNCIL, changes_json: 'not json' }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'h5', event_id: COUNCIL, text: '' }))).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => add({ id: 'h6', event_id: 'evt_nope' }))).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    d.close();
  });
});

describe.each(stores())('势力存取（%s存档）', (_n, make) => {
  it('初始：来自静态定义；种子重复执行不覆盖', () => {
    const s = make();
    expect(s.read((tx) => tx.factions())).toEqual([
      { id: BW, strength: FACTION_DEFS[BW].strength, attitude: FACTION_DEFS[BW].attitude },
      { id: QY, strength: FACTION_DEFS[QY].strength, attitude: FACTION_DEFS[QY].attitude },
    ].sort((x, y) => x.id.localeCompare(y.id)));
    expect(s.read((tx) => tx.factionRelations())).toEqual([{ a: BW, b: QY, value: -30 }]);
    expect(s.read((tx) => tx.factionHistory())).toEqual([]);
  });
  it('应用影响：返回实际变化、限幅 ±20、夹回范围、关系与方向无关', () => {
    const s = make();
    const ch = s.transact((tx) =>
      tx.applyFactionEffects([
        { kind: 'strength', faction: BW, delta: -8 },
        { kind: 'attitude', faction: QY, delta: 999 },
        { kind: 'relation', a: QY, b: BW, delta: -6 },
      ]),
    );
    expect(ch).toEqual([
      { kind: 'strength', faction: BW, other: null, from: 40, to: 32 },
      { kind: 'attitude', faction: QY, other: null, from: 10, to: 10 + MAX_FACTION_DELTA },
      { kind: 'relation', faction: BW, other: QY, from: -30, to: -36 },
    ]);
    expect(s.read((tx) => tx.factions().find((f) => f.id === BW)!.strength)).toBe(32);
    expect(s.read((tx) => tx.factionRelations())).toEqual([{ a: BW, b: QY, value: -36 }]);
  });
  it('未知势力 NOT_FOUND；回滚', () => {
    const s = make();
    expect(code(() => s.transact((tx) => tx.applyFactionEffects([{ kind: 'strength', faction: 'fac_nope' as never, delta: 1 }])))).toBe('NOT_FOUND');
    expect(() =>
      s.transact((tx) => {
        tx.applyFactionEffects([{ kind: 'strength', faction: BW, delta: 10 }]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.read((tx) => tx.factions().find((f) => f.id === BW)!.strength)).toBe(40);
  });
  it('历史：每个事件只能记一次；事件必须存在；变化不能为空', () => {
    const s = make();
    const add = (eventId: string, changes = [{ kind: 'strength' as const, faction: BW, other: null, from: 40, to: 32 }]) => s.transact((tx) => tx.addFactionHistory({ eventId, gameMinutes: 5, text: '事', changes }));
    add(RAID);
    expect(code(() => add(RAID))).toBe('CONFLICT');
    expect(code(() => add('evt_nope'))).toBe('NOT_FOUND');
    expect(code(() => add(COUNCIL, []))).not.toBe('OK');
    expect(s.read((tx) => tx.factionHistory()).map((h) => h.eventId)).toEqual([RAID]);
    add(COUNCIL);
    expect(s.read((tx) => tx.factionHistory(1)).map((h) => h.eventId)).toEqual([COUNCIL]);
  });
});

async function game() {
  const store = createMemoryGameStore(createInitialPlayer());
  const app = await buildApp({ store, clock: { now: () => T0 }, rng: fixedRng(0) });
  return gameOn(store, app);
}
function gameOn(store: GameStore, app: Awaited<ReturnType<typeof buildApp>>) {
  const goto = (minutes: number) =>
    store.transact((tx) => {
      for (let delta = minutes - tx.gameMinutes(); delta > 0; delta = minutes - tx.gameMinutes()) tx.advanceGameClock(Math.min(delta, 2880));
      return tickWorld(tx, { at: T0, actionId: null });
    });
  const moveTo = (id: string) => store.transact((tx) => tx.savePlayer({ ...tx.player(), location: { id, name: id } }));
  const join = (id: string) => app.inject({ method: 'POST', url: `/api/v1/world/events/${id}/join` });
  const fac = (id: string) => store.read((tx) => tx.factions().find((f) => f.id === id)!);
  const rel = () => store.read((tx) => tx.factionRelations()[0]!.value);
  const town = () => store.read((tx) => tx.locations().find((l) => l.id === TOWN)!);
  const news = (id: string) => store.read((tx) => tx.news().find((n) => n.eventId === id && n.kind === 'news'));
  const history = () => store.read((tx) => tx.factionHistory());
  return { store, app, goto, moveTo, join, fac, rel, town, news, history };
}

/** 玩家全程出手：劫案 → 议事 → 来犯 */
async function playAllJoined(g: ReturnType<typeof gameOn>) {
  g.goto(def(RAID).startAt);
  g.moveTo('loc_foot_path');
  expect((await g.join(RAID)).statusCode).toBe(200);
  g.goto(def(COUNCIL).startAt);
  g.moveTo('loc_qingyun_hall');
  expect((await g.join(COUNCIL)).statusCode).toBe(200);
  g.goto(def(ASSAULT).startAt);
  g.moveTo('loc_qingyun_gate');
  expect((await g.join(ASSAULT)).statusCode).toBe(200);
  g.goto(def(AFTER).startAt);
}

describe('事件链「黑风寨之患」', () => {
  it('全程没出手（一次大跨度推进）：黑风寨坐大、山下封了又开，议事按「没人出手」的说法', async () => {
    const g = await game();
    g.goto(def(AFTER).startAt + 10);
    // 劫案没人管：黑风寨 +8、青云 −2、关系 −4；议事分支：青云 +2；来犯没人守：青云 −8、黑风寨 +10、关系 −6；风波过后：黑风寨 ≥55 → 青云态度 −2
    expect(g.fac(BW)).toMatchObject({ strength: 58 });
    expect(g.fac(QY)).toMatchObject({ strength: 60 - 2 + 2 - 8, attitude: 10 - 2 });
    expect(g.rel()).toBe(-40);
    expect(g.town()).toMatchObject({ status: 'open', reason: null }); // 先封后开
    expect(g.news(COUNCIL)!.text).toContain('拦路');
    expect(g.news(AFTER)!.text).toContain('气焰未消');
    expect(g.history().map((h) => h.eventId)).toEqual([RAID, COUNCIL, ASSAULT, AFTER]);
  });
  it('全程出手：山贼受挫、不封镇，结局是「元气大伤」；势力偏向青云', async () => {
    const g = await game();
    await playAllJoined(g);
    expect(g.fac(BW).strength).toBe(40 - 8 - 12 - 3);
    expect(g.fac(QY)).toMatchObject({ strength: 60 + 4 + 4, attitude: 10 + 4 + 3 + 6 });
    expect(g.rel()).toBe(-30 - 6 - 8);
    expect(g.fac(BW).attitude).toBe(0 - 6 - 8);
    expect(g.town().status).toBe('open'); // 从未封过
    expect(g.news(COUNCIL)!.text).toContain('喝退了山贼');
    expect(g.news(AFTER)!.text).toContain('元气大伤');
    expect([RAID, COUNCIL, ASSAULT].map((id) => g.news(id)!.participated)).toEqual([true, true, true]);
  });
  it('出手不同结局不同：同样的流程，玩家的选择让两个势力的最终状态完全不同', async () => {
    const a = await game();
    a.goto(def(AFTER).startAt + 10);
    const b = await game();
    await playAllJoined(b);
    expect(a.fac(BW).strength).toBeGreaterThan(b.fac(BW).strength);
    expect(a.fac(QY).strength).toBeLessThan(b.fac(QY).strength);
  });
  it('只出手一半：劫案出手、来犯没守——各自按自己的分支算，不互相覆盖', async () => {
    const g = await game();
    g.goto(def(RAID).startAt);
    g.moveTo('loc_foot_path');
    await g.join(RAID);
    g.goto(def(AFTER).startAt);
    // 黑风寨：40 −8（劫案出手）= 32；来犯没守 +10 = 42；风波过后无分支（31..54）
    expect(g.fac(BW).strength).toBe(42);
    expect(g.news(AFTER)!.text).toBe(def(AFTER).resolved);
  });
  it('劫案没人管：小镇被封并写明原因；风波过后解封。被封期间玩家在镇外进不去，在镇里能出来', async () => {
    const g = await game();
    g.goto(def(RAID).startAt + def(RAID).windowMinutes);
    expect(g.town()).toMatchObject({ status: 'blocked', reason: '山贼拦路，镇上去不得' });
    g.moveTo('loc_foot_path');
    const enter = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'fac-enter-0001', kind: 'move', locationId: TOWN } });
    expect(enter.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(enter.json()).message).toContain('山贼拦路');
    g.moveTo(TOWN);
    const leave = await g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'fac-leave-0001', kind: 'move', locationId: 'loc_foot_path' } });
    expect(leave.statusCode).toBe(200);
    g.goto(def(AFTER).startAt);
    expect(g.town().status).toBe('open');
  });
  it('重复调度不重复生效：势力数值、历史、新闻都不变', async () => {
    const g = await game();
    g.goto(def(AFTER).startAt + 10);
    const snap = () => JSON.stringify([g.store.read((tx) => tx.factions()), g.rel(), g.history(), g.store.read((tx) => tx.news())]);
    const s0 = snap();
    g.goto(def(AFTER).startAt + 20);
    g.goto(def(AFTER).startAt + 5000);
    expect(snap()).toBe(s0);
  });
  it('确定性：内存与 SQLite 存档走同样的流程，势力与历史完全一致', async () => {
    const a = await game();
    const d = fresh();
    const sq = createSqliteGameStore(d.db, createInitialPlayer());
    const b = gameOn(sq, await buildApp({ store: sq, clock: { now: () => T0 }, rng: fixedRng(0) }));
    for (const g of [a, b]) {
      g.goto(def(RAID).startAt);
      g.moveTo('loc_foot_path');
      await g.join(RAID);
      g.goto(def(AFTER).startAt + 1);
    }
    const view = (g: ReturnType<typeof gameOn>) => JSON.stringify([g.store.read((tx) => tx.factions()), g.rel(), g.history().map(({ id: _id, ...h }) => h)]);
    expect(view(a)).toBe(view(b));
  });
});

describe('GET /world/factions', () => {
  it('开局：两个势力的现状与关系，没有历史', async () => {
    const g = await game();
    const body = FactionsResponseSchema.parse((await g.app.inject({ method: 'GET', url: '/api/v1/world/factions' })).json());
    expect(body.factions.map((f) => [f.name, f.strengthLabel, f.attitudeLabel])).toEqual([
      ['黑风寨', '势均力敌', '观望'],
      ['青云派', '强盛', '观望'],
    ]);
    expect(body.relations).toEqual([{ a: BW, b: QY, aName: '黑风寨', bName: '青云派', value: -30, label: '嫌隙' }]);
    expect(body.history).toEqual([]);
  });
  it('历史只含已了结的事件，最近的在前；变化明细可读；不透露未发生的事', async () => {
    const g = await game();
    g.goto(def(RAID).startAt); // 劫案刚开始，还没了结
    const get = async () => FactionsResponseSchema.parse((await g.app.inject({ method: 'GET', url: '/api/v1/world/factions' })).json());
    expect((await get()).history).toEqual([]);
    g.goto(def(COUNCIL).startAt + def(COUNCIL).windowMinutes);
    const body = await get();
    expect(body.history.map((h) => h.eventId)).toEqual([COUNCIL, RAID]);
    expect(body.history[1]).toMatchObject({ title: '山道劫案', when: '第 4 天 · 午时' }); // 窗口 09:00–12:00，了结于 12:00
    expect(body.history[1]!.changes).toContain('黑风寨 实力 40 → 48');
    expect(body.history[1]!.changes).toContain('黑风寨与青云派 关系 -30 → -34');
    const text = JSON.stringify(body);
    expect(text).not.toContain('元气大伤'); // 后面才会发生的结局
    expect(text).not.toContain('evt_blackwind_assault');
  });
  it('写方法不存在', async () => {
    const g = await game();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect((await g.app.inject({ method, url: '/api/v1/world/factions', payload: {} })).statusCode, method).toBe(404);
  });
});

describe('审计：势力变化可重放', () => {
  it('从劫案到风波过后（含玩家出手与错过）：按序重放全部审计差异 = 最终状态', async () => {
    const d = fresh();
    const store = createSqliteGameStore(d.db, createInitialPlayer());
    const app = await buildApp({ store, clock: { now: () => T0 }, rng: fixedRng(0) });
    const g = gameOn(store, app);
    type Snap = Record<string, unknown>;
    const NESTED = ['inventory', 'npcs', 'relations', 'memories', 'quests', 'locations', 'worldEvents', 'factions', 'factionRelations', 'personalEvents'];
    const initial = store.read((tx) => snapshot(tx)) as Snap;
    g.goto(def(RAID).startAt - 30);
    expect((await app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: 'fac-audit-0001', kind: 'move', locationId: 'loc_foot_path' } })).statusCode).toBe(200);
    g.goto(def(RAID).startAt);
    expect((await g.join(RAID)).statusCode).toBe(200);
    g.goto(def(AFTER).startAt + 10); // 议事、来犯没人到场
    const final = store.read((tx) => snapshot(tx)) as Snap;

    const cur: Snap = structuredClone(initial);
    const rows = d.sqlite.prepare('select seq, event_type, before_json, after_json from audit_events order by seq').all() as { seq: number; event_type: string; before_json: string | null; after_json: string | null }[];
    expect(rows.filter((r) => r.event_type.startsWith('world.event.')).length).toBeGreaterThanOrEqual(12);
    for (const r of rows) {
      const before = (r.before_json ? JSON.parse(r.before_json) : {}) as Snap;
      const after = (r.after_json ? JSON.parse(r.after_json) : {}) as Snap;
      if ('gameMinutes' in before) cur.gameMinutes = before.gameMinutes; // 测试里手工推进时钟（真实流程中由已审计的行动推进）
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
    expect(final.factionHistoryCount).toBe(3); // 劫案（出手）、议事、来犯；风波过后在这个局面下没有势力变化
    d.close();
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
      for (let dl = to - tx.gameMinutes(); dl > 0; dl = to - tx.gameMinutes()) tx.advanceGameClock(Math.min(dl, 2880));
      tickWorld(tx, { at: T0, actionId: null });
    });

  it('往返：势力、关系、历史、被封的小镇原样恢复，之后的剧情接着走', () => {
    const a = sqliteGame();
    play(a.s, def(RAID).startAt + def(RAID).windowMinutes); // 劫案没人管
    const raw = exportRaw(a.s);
    expect(raw.world.factionHistory).toHaveLength(1);
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.factions())).toEqual(a.s.read((tx) => tx.factions()));
    expect(b.s.read((tx) => tx.factionRelations())).toEqual(a.s.read((tx) => tx.factionRelations()));
    expect(b.s.read((tx) => tx.factionHistory())).toEqual(a.s.read((tx) => tx.factionHistory()));
    expect(b.s.read((tx) => tx.locations().find((l) => l.id === TOWN))!.status).toBe('blocked');
    play(b.s, def(AFTER).startAt + 1);
    expect(b.s.read((tx) => tx.locations().find((l) => l.id === TOWN))!.status).toBe('open');
    expect(b.s.read((tx) => tx.factionHistory()).map((h) => h.eventId)).toEqual([RAID, COUNCIL, ASSAULT, AFTER]);
  });
  it('旧存档（没有势力）：全部初始，导入覆盖原有状态', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    delete raw.world.factions;
    delete raw.world.factionRelations;
    delete raw.world.factionHistory;
    const b = sqliteGame();
    play(b.s, def(AFTER).startAt + 1);
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.factions().find((f) => f.id === BW)!.strength)).toBe(40);
    expect(b.s.read((tx) => tx.factionHistory())).toEqual([]);
  });
  it.each([
    ['未知势力', (r: { world: { factions: unknown[] } }) => (r.world.factions = [{ id: 'fac_nope', strength: 10, attitude: 0 }])],
    ['势力重复', (r: { world: { factions: unknown[] } }) => (r.world.factions = [{ id: QY, strength: 10, attitude: 0 }, { id: QY, strength: 20, attitude: 0 }])],
    ['未知的势力关系', (r: { world: { factionRelations: unknown[] } }) => (r.world.factionRelations = [{ a: 'fac_a', b: 'fac_b', value: 0 }])],
    ['势力关系重复', (r: { world: { factionRelations: unknown[] } }) => (r.world.factionRelations = [{ a: BW, b: QY, value: 0 }, { a: BW, b: QY, value: 1 }])],
    ['历史指向未知事件', (r: { world: { factionHistory: unknown[] } }) => (r.world.factionHistory = [{ id: 'h1', eventId: 'evt_nope', gameMinutes: 1, text: 'x', changes: [{ kind: 'strength', faction: BW, other: null, from: 1, to: 2 }] }])],
    ['历史对应的事件还没了结', (r: { world: { factionHistory: unknown[] } }) => (r.world.factionHistory = [{ id: 'h1', eventId: RAID, gameMinutes: 1, text: 'x', changes: [{ kind: 'strength', faction: BW, other: null, from: 1, to: 2 }] }])],
    ['同一事件的历史重复', (r: { world: { factionHistory: unknown[]; events: unknown[] } }) => {
      r.world.events = [{ id: RAID, state: 'missed', rumored: true, participated: false, resolvedAt: 5 }];
      const h = { eventId: RAID, gameMinutes: 1, text: 'x', changes: [{ kind: 'strength', faction: BW, other: null, from: 1, to: 2 }] };
      r.world.factionHistory = [{ id: 'h1', ...h }, { id: 'h2', ...h }];
    }],
    ['历史涉及未知势力', (r: { world: { factionHistory: unknown[]; events: unknown[] } }) => {
      r.world.events = [{ id: RAID, state: 'missed', rumored: true, participated: false, resolvedAt: 5 }];
      r.world.factionHistory = [{ id: 'h1', eventId: RAID, gameMinutes: 1, text: 'x', changes: [{ kind: 'strength', faction: 'fac_nope', other: null, from: 1, to: 2 }] }];
    }],
  ])('导入拒绝：%s，目标存档不变', (_n, mutate) => {
    const raw = exportRaw(sqliteGame().s);
    (mutate as (r: unknown) => void)(raw);
    const b = sqliteGame();
    const before = JSON.stringify([b.s.read((tx) => tx.factions()), b.s.read((tx) => tx.factionHistory())]);
    expect(() => importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0)).toThrow();
    expect(JSON.stringify([b.s.read((tx) => tx.factions()), b.s.read((tx) => tx.factionHistory())])).toBe(before);
  });
  it.each([
    ['实力超范围', { world: { factions: [{ id: QY, strength: 101, attitude: 0 }] } }],
    ['态度超范围', { world: { factions: [{ id: QY, strength: 10, attitude: -101 }] } }],
    ['关系未排序', { world: { factionRelations: [{ a: QY, b: BW, value: 0 }] } }],
    ['历史的变化为空', { world: { factionHistory: [{ id: 'h', eventId: RAID, gameMinutes: 1, text: 'x', changes: [] }] } }],
    ['关系变化缺对方', { world: { factionHistory: [{ id: 'h', eventId: RAID, gameMinutes: 1, text: 'x', changes: [{ kind: 'relation', faction: BW, other: null, from: 1, to: 2 }] }] } }],
  ])('解析拒绝：%s', (_n, patch) => {
    const raw = exportRaw(sqliteGame().s);
    Object.assign(raw.world, patch.world);
    expect(() => parseSaveFile(JSON.stringify(raw))).toThrow();
  });
});

describe('迁移：带数据升级到势力', () => {
  it('旧库升级后有势力表，种子补齐；已有玩家数据不变', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-fac-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const cut = (journal.entries as { tag: string }[]).findIndex((e) => e.tag.includes('factions'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, cut);
      writeFileSync(journalPath, JSON.stringify(journal));
      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      d.sqlite.prepare("insert into players (id, display_name) values ('player_1', '林惊鸿')").run();
      runMigrations(d.db);
      expect((d.sqlite.prepare('select count(*) c from factions').get() as { c: number }).c).toBe(0);
      const s = createSqliteGameStore(d.db, createInitialPlayer());
      createSqliteGameStore(d.db);
      expect(s.read((tx) => tx.factions())).toHaveLength(2);
      expect(s.read((tx) => tx.factionRelations())).toHaveLength(1);
      expect((d.sqlite.prepare("select display_name n from players where id='player_1'").get() as { n: string }).n).toBe('林惊鸿');
      d.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
