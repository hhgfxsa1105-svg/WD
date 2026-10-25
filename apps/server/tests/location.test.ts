import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { AuditActionResponseSchema, ErrorResponseSchema, WorldMapResponseSchema } from '@jhz/contracts';
import { LOCATION_DEFS, createInitialPlayer, fixedRng, moveCost } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { DB_LOCATION_STATUSES } from '../src/db/schema.js';
import { loadAiConfig } from '../src/modules/ai/config.js';
import { createAiGateway } from '../src/modules/ai/gateway.js';
import { createKeywordMockProvider, createMockProvider } from '../src/modules/ai/mock.js';
import { importSave } from '../src/modules/player/import.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore, ensureSeed } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { snapshotWorld } from '../src/modules/store/world-rules.js';

const T0 = new Date(2026, 9, 25, 10, 0, 0).getTime();
const GATE = 'loc_qingyun_gate';
const YARD = 'loc_qingyun_yard';
const PATH = 'loc_foot_path';
const TOWN = 'loc_foot_town';
const IDS = Object.keys(LOCATION_DEFS).sort();

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
  [
    'SQLite',
    () => {
      const d = fresh();
      ensureSeed(d.db, createInitialPlayer());
      return createSqliteGameStore(d.db);
    },
  ],
];

describe('数据库约束（locations）', () => {
  it('枚举与规则层一致', () => {
    expect([...DB_LOCATION_STATUSES]).toEqual(['open', 'blocked']);
  });
  const insert = (d: ReturnType<typeof fresh>, over: Record<string, unknown>) =>
    d.sqlite.prepare('insert into locations (id, status, reason, visited) values (@id,@status,@reason,@visited)').run({ id: 'loc_x', status: 'open', reason: null, visited: 0, ...over });
  it.each([
    ['ID 格式', { id: 'x1' }],
    ['状态非法', { status: 'closed' }],
    ['封锁却没有原因', { status: 'blocked' }],
    ['开放却带原因', { reason: '塌方' }],
    ['原因为空串', { status: 'blocked', reason: '' }],
    ['原因过长', { status: 'blocked', reason: 'x'.repeat(61) }],
    ['visited 非 0/1', { visited: 2 }],
  ])('拒绝：%s', (_n, over) => {
    const d = fresh();
    expect(code(() => insert(d, over))).toBe('SQLITE_CONSTRAINT_CHECK');
    d.close();
  });
  it('合法行可写入', () => {
    const d = fresh();
    expect(code(() => insert(d, { id: 'loc_ok', status: 'blocked', reason: '塌方' }))).toBe('OK');
    d.close();
  });
});

describe.each(stores())('地点状态（%s存档）', (_n, make) => {
  it('初始：全部开放，只去过山门；种子重复执行不覆盖', () => {
    const s = make();
    const l = s.read((tx) => tx.locations());
    expect(l.map((x) => x.id).sort()).toEqual(IDS);
    expect(l.filter((x) => x.visited).map((x) => x.id)).toEqual([GATE]);
    expect(l.every((x) => x.status === 'open' && x.reason === null)).toBe(true);
  });
  it('封锁需要原因，恢复开放会清除原因；未知地点被拒绝', () => {
    const s = make();
    s.transact((tx) => tx.setLocationStatus(PATH, 'blocked', '山道塌方'));
    expect(s.read((tx) => tx.locations().find((x) => x.id === PATH))).toMatchObject({ status: 'blocked', reason: '山道塌方' });
    s.transact((tx) => tx.setLocationStatus(PATH, 'open', null));
    expect(s.read((tx) => tx.locations().find((x) => x.id === PATH))).toMatchObject({ status: 'open', reason: null });
    expect(() => s.transact((tx) => tx.setLocationStatus(PATH, 'blocked', null))).toThrow();
    expect(() => s.transact((tx) => tx.setLocationStatus('loc_nowhere', 'open', null))).toThrow();
    expect(() => s.transact((tx) => tx.visitLocation('loc_nowhere'))).toThrow();
  });
  it('事务内抛错则回滚', () => {
    const s = make();
    expect(() =>
      s.transact((tx) => {
        tx.setLocationStatus(PATH, 'blocked', '塌方');
        tx.visitLocation(TOWN);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const l = s.read((tx) => tx.locations());
    expect(l.find((x) => x.id === PATH)!.status).toBe('open');
    expect(l.find((x) => x.id === TOWN)!.visited).toBe(false);
  });
});

async function game(opts: { player?: Partial<ReturnType<typeof createInitialPlayer>>; keyword?: boolean } = {}) {
  const store = createMemoryGameStore({ ...createInitialPlayer(), ...opts.player });
  const ai = createAiGateway({ config: { ...loadAiConfig({ AI_PROVIDER: 'mock' }), dailyCallLimit: 100 }, provider: opts.keyword ? createKeywordMockProvider() : createMockProvider({ steps: [] }), log: store.aiLog, clock: { now: () => T0 } });
  const app = await buildApp({ store, ai, clock: { now: () => T0 }, rng: fixedRng(0) });
  let n = 0;
  const move = (locationId: string) => app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: `loc-key-${String(++n).padStart(5, '0')}`, kind: 'move', locationId } });
  const map = async () => WorldMapResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/world/map' })).json());
  return { store, app, move, map };
}

describe('移动与地图接口', () => {
  it('山门的出口：山门→练功场、山道；耗时与体力来自连线', async () => {
    const g = await game();
    const m = await g.map();
    expect(m.current).toMatchObject({ id: GATE, status: 'open', reason: null });
    expect(m.exits.map((x) => x.id).sort()).toEqual([PATH, YARD].sort());
    const toPath = m.exits.find((x) => x.id === PATH)!;
    expect(toPath).toMatchObject({ visited: false, stamina: moveCost(GATE, PATH)!.stamina, minutes: 60 });
    expect(m.exits.find((x) => x.id === YARD)).toMatchObject({ minutes: 30 });
  });
  it('出口不泄露描述与未到过的地点；未去过的地点不出现在地区列表', async () => {
    const g = await game();
    const text = JSON.stringify(await g.map());
    expect(text).not.toContain(LOCATION_DEFS[PATH].description);
    expect(text).not.toContain(LOCATION_DEFS[TOWN].name);
    const m = await g.map();
    expect(m.regions.flatMap((r) => r.locations.map((l) => l.id))).toEqual([GATE]);
  });
  it('走过之后：地点被标记为去过，地区列表出现；两步到小镇', async () => {
    const g = await game();
    expect((await g.move(PATH)).statusCode).toBe(200);
    expect((await g.move(TOWN)).statusCode).toBe(200);
    const m = await g.map();
    expect(m.current.id).toBe(TOWN);
    const ids = m.regions.flatMap((r) => r.locations.map((l) => l.id)).sort();
    expect(ids).toEqual([GATE, PATH, TOWN].sort());
    expect(m.regions.find((r) => r.locations.some((l) => l.id === TOWN))!.name).toBe('山下');
    // 回头：山道已去过
    expect(m.exits.find((x) => x.id === PATH)!.visited).toBe(true);
  });
  it('不相邻、未知地点、原地不动', async () => {
    const g = await game();
    expect((await g.move(TOWN)).statusCode).toBe(422);
    expect((await g.move('loc_nowhere')).statusCode).toBe(404);
    expect((await g.move(GATE)).statusCode).toBe(422);
  });
  it('封锁：不能进入并说明原因，状态不变；离开封锁地点不受限；解除后可通行', async () => {
    const g = await game();
    g.store.transact((tx) => tx.setLocationStatus(PATH, 'blocked', '山道塌方'));
    const before = g.store.read((tx) => tx.player());
    const r = await g.move(PATH);
    expect(r.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(r.json()).message).toContain('山道塌方');
    expect(g.store.read((tx) => tx.player())).toEqual(before);
    expect((await g.map()).exits.find((x) => x.id === PATH)).toMatchObject({ status: 'blocked', reason: '山道塌方' });

    g.store.transact((tx) => tx.setLocationStatus(GATE, 'blocked', '山门戒严'));
    expect((await g.move(YARD)).statusCode).toBe(200); // 所在地被封锁，仍能离开
    g.store.transact((tx) => tx.setLocationStatus(PATH, 'open', null));
    expect((await g.move(GATE)).statusCode).toBe(422); // 山门仍封锁
    g.store.transact((tx) => tx.setLocationStatus(GATE, 'open', null));
    expect((await g.move(GATE)).statusCode).toBe(200);
    expect((await g.move(PATH)).statusCode).toBe(200);
  });
  it('封锁优先于体力不足的判断；体力不足不改变状态', async () => {
    const g = await game({ player: { stamina: 1 } });
    g.store.transact((tx) => tx.setLocationStatus(PATH, 'blocked', '山道塌方'));
    expect(ErrorResponseSchema.parse((await g.move(PATH)).json()).message).toContain('山道塌方');
    g.store.transact((tx) => tx.setLocationStatus(PATH, 'open', null));
    const before = g.store.read((tx) => tx.player());
    expect((await g.move(PATH)).statusCode).toBe(422);
    expect(g.store.read((tx) => tx.player())).toEqual(before);
  });
  it('审计：移动事件的差异包含地点「去过」标记，且同一幂等键重放不重复', async () => {
    const g = await game();
    const res = await g.move(PATH);
    const body = res.json() as { actionId: string };
    const audit = AuditActionResponseSchema.parse((await g.app.inject({ method: 'GET', url: `/api/v1/audit/actions/${body.actionId}` })).json());
    expect(JSON.stringify(audit)).toContain('locations');
  });
  it('自由输入「去山道」可识别新地点；说「去小镇」从山门不相邻，被服务端拒绝', async () => {
    const g = await game({ keyword: true });
    const free = (input: string, key: string) => g.app.inject({ method: 'POST', url: '/api/v1/actions', payload: { kind: 'free', idempotencyKey: key, input } });
    const far = await free('去小镇', 'free-loc-key-0001');
    expect(far.statusCode).toBe(422); // 山门不与小镇相邻
    expect((await g.map()).current.id).toBe(GATE);
    expect((await free('去山道', 'free-loc-key-0002')).statusCode).toBe(200);
    expect((await g.map()).current.id).toBe(PATH);
  });
  it('地图不透露未发现的地点：地区简介不点名；离开的 NPC 不算在场', async () => {
    const g = await game();
    const text = JSON.stringify((await g.map()).regions);
    for (const id of ['loc_qingyun_hall', 'loc_qingyun_library', TOWN]) expect(text).not.toContain(LOCATION_DEFS[id as keyof typeof LOCATION_DEFS].name.split(' · ')[1]!);
    expect((await g.map()).current.npcs.map((n) => n.id)).toContain('npc_gate_guard');
    g.store.transact((tx) => tx.setNpcStatus('npc_gate_guard', 'away'));
    expect((await g.map()).current.npcs.map((n) => n.id)).not.toContain('npc_gate_guard');
  });
  it('写接口不存在', async () => {
    const g = await game();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect((await g.app.inject({ method, url: '/api/v1/world/map', payload: {} })).statusCode, method).toBe(404);
  });
});

describe('存档：地点状态往返与校验', () => {
  const sqliteGame = (player = createInitialPlayer()) => {
    const d = fresh();
    ensureSeed(d.db, player);
    return { d, s: createSqliteGameStore(d.db) };
  };
  const exportRaw = (s: GameStore) => JSON.parse(JSON.stringify(s.read((tx) => buildSaveFile(tx.player(), snapshotWorld(tx)))));

  it('导出包含地点；导入后原样恢复，且当前所在地必为「去过」', () => {
    const a = sqliteGame();
    a.s.transact((tx) => {
      tx.visitLocation(PATH);
      tx.setLocationStatus(TOWN, 'blocked', '集市封街');
    });
    const raw = exportRaw(a.s);
    expect(raw.world.locations.find((l: { id: string }) => l.id === TOWN)).toMatchObject({ status: 'blocked', reason: '集市封街' });
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)));
    expect(b.s.read((tx) => tx.locations())).toEqual(a.s.read((tx) => tx.locations()));
  });
  it('旧存档（没有 locations）导入后回到初始状态，当前所在地算去过', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    raw.player.location = { id: YARD, name: '练功场' };
    delete raw.world.locations;
    const b = sqliteGame();
    b.s.transact((tx) => tx.setLocationStatus(PATH, 'blocked', '塌方')); // 导入应覆盖旧状态
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)));
    const l = b.s.read((tx) => tx.locations());
    expect(l.filter((x) => x.visited).map((x) => x.id).sort()).toEqual([GATE, YARD].sort());
    expect(l.every((x) => x.status === 'open')).toBe(true);
  });
  it('v1 存档（只有角色）导入后，当前所在地也算去过', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    raw.schemaVersion = 1;
    delete raw.world;
    raw.player.location = { id: TOWN, name: '山下 · 小镇' };
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)));
    expect(b.s.read((tx) => tx.locations()).filter((x) => x.visited).map((x) => x.id).sort()).toEqual([GATE, TOWN].sort());
  });
  it.each([
    ['封锁无原因', { id: PATH, status: 'blocked', reason: null, visited: false }],
    ['开放带原因', { id: PATH, status: 'open', reason: '塌方', visited: false }],
    ['未知状态', { id: PATH, status: 'gone', reason: null, visited: false }],
  ])('解析拒绝非法存档：%s', (_n, bad) => {
    const raw = exportRaw(sqliteGame().s);
    raw.world.locations = [bad];
    expect(() => parseSaveFile(JSON.stringify(raw))).toThrow();
  });
  it.each([
    ['未知地点', [{ id: 'loc_unknown_place', status: 'open', reason: null, visited: true }]],
    ['重复地点', [{ id: PATH, status: 'open', reason: null, visited: true }, { id: PATH, status: 'open', reason: null, visited: false }]],
  ])('导入拒绝：%s，且目标存档不变', (_n, locs) => {
    const raw = exportRaw(sqliteGame().s);
    raw.world.locations = locs;
    const b = sqliteGame();
    const before = b.s.read((tx) => tx.locations());
    expect(() => importSave(b.d.db, parseSaveFile(JSON.stringify(raw)))).toThrow();
    expect(b.s.read((tx) => tx.locations())).toEqual(before);
  });
});

describe('迁移：带数据升级到 locations', () => {
  it('旧库升级后补齐地点种子，已有玩家数据不变', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-loc-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const cut = (journal.entries as { tag: string }[]).findIndex((e) => e.tag.includes('locations'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, cut);
      writeFileSync(journalPath, JSON.stringify(journal));
      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      d.sqlite.prepare("insert into players (id, display_name) values ('player_1', '林惊鸿')").run();
      runMigrations(d.db);
      expect((d.sqlite.prepare('select count(*) c from locations').get() as { c: number }).c).toBe(0);
      ensureSeed(d.db, createInitialPlayer());
      ensureSeed(d.db, createInitialPlayer()); // 重复执行
      const rows = d.sqlite.prepare('select id, visited from locations order by id').all() as { id: string; visited: number }[];
      expect(rows.map((r) => r.id)).toEqual(IDS);
      expect(rows.filter((r) => r.visited).map((r) => r.id)).toEqual([GATE]);
      expect((d.sqlite.prepare("select display_name n from players where id='player_1'").get() as { n: string }).n).toBe('林惊鸿');
      d.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
