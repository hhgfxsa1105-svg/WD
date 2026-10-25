import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, CultivationResponseSchema, LogResponseSchema, WorldTimeResponseSchema, type PlayerState } from '@jhz/contracts';
import {
  ACTION_MINUTES,
  BREAKTHROUGH_RULES,
  IDLE_CULTIVATION,
  INITIAL_GAME_MINUTES,
  MAX_ADVANCE_MINUTES,
  MINUTES_PER_DAY,
  createInitialPlayer,
  fixedRng,
  gameDate,
} from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadAiConfig } from '../src/modules/ai/config.js';
import { createAiGateway } from '../src/modules/ai/gateway.js';
import { createKeywordMockProvider, createMockProvider } from '../src/modules/ai/mock.js';
import { importSave, legacyCooldown } from '../src/modules/player/import.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { snapshotWorld } from '../src/modules/store/world-rules.js';

const T0 = 1_800_000_000_000;
const MIN = IDLE_CULTIVATION.tickMs;
const GATE = 'loc_qingyun_gate';
const YARD = 'loc_qingyun_yard';
const PATH = 'loc_foot_path';

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

describe.each(stores())('游戏时钟存取（%s存档）', (_n, make) => {
  it('起点是第 1 天辰时；推进只增不减', () => {
    const s = make();
    expect(s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES);
    expect(s.transact((tx) => tx.advanceGameClock(0))).toBe(INITIAL_GAME_MINUTES);
    expect(s.transact((tx) => tx.advanceGameClock(60))).toBe(INITIAL_GAME_MINUTES + 60);
    expect(s.transact((tx) => tx.advanceGameClock(MAX_ADVANCE_MINUTES))).toBe(INITIAL_GAME_MINUTES + 60 + MAX_ADVANCE_MINUTES);
  });
  it.each([[-1], [1.5], [Number.NaN], [MAX_ADVANCE_MINUTES + 1], [Number.POSITIVE_INFINITY]])('拒绝非法推进 %s，时间不变', (bad) => {
    const s = make();
    expect(code(() => s.transact((tx) => tx.advanceGameClock(bad)))).toBe('VALIDATION_FAILED');
    expect(s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES);
  });
  it('事务内抛错则回滚，时间不推进', () => {
    const s = make();
    expect(() =>
      s.transact((tx) => {
        tx.advanceGameClock(300);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES);
  });
  it('日志记录写入时刻的游戏时间', () => {
    const s = make();
    const log = s.transact((tx) => {
      tx.advanceGameClock(45);
      return tx.appendEvent({ actionId: null, eventType: 't', before: null, after: null, at: 1, log: { type: 'system', narrative: 'x', changes: [], breakthrough: null, idle: null, note: null } });
    });
    expect(log!.gameMinutes).toBe(INITIAL_GAME_MINUTES + 45);
    expect(s.read((tx) => tx.recentLog(5)).at(-1)!.gameMinutes).toBe(INITIAL_GAME_MINUTES + 45);
  });
});

describe('数据库约束（game_clock）', () => {
  it('只有一行 main，分钟非负；种子重复执行不覆盖', () => {
    const d = fresh();
    const s = createSqliteGameStore(d.db);
    s.transact((tx) => tx.advanceGameClock(500));
    createSqliteGameStore(d.db); // 再次种子
    expect(createSqliteGameStore(d.db).read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES + 500);
    expect(code(() => d.sqlite.prepare("insert into game_clock (id, minutes) values ('other', 1)").run())).toBe('SQLITE_CONSTRAINT_CHECK');
    expect(code(() => d.sqlite.prepare("update game_clock set minutes = -1 where id = 'main'").run())).toBe('SQLITE_CONSTRAINT_CHECK');
    d.close();
  });
});

async function game(opts: { player?: Partial<PlayerState>; keyword?: boolean; rng?: number } = {}) {
  const store = createMemoryGameStore({ ...createInitialPlayer(), ...opts.player });
  const ai = createAiGateway({ config: { ...loadAiConfig({ AI_PROVIDER: 'mock' }), dailyCallLimit: 100 }, provider: opts.keyword ? createKeywordMockProvider() : createMockProvider({ steps: [] }), log: store.aiLog, clock: { now: () => T0 } });
  const app = await buildApp({ store, ai, clock: { now: () => T0 }, rng: fixedRng(opts.rng ?? 0) });
  let n = 0;
  const post = (payload: object, key?: string) => app.inject({ method: 'POST', url: '/api/v1/actions', payload: { idempotencyKey: key ?? `clock-key-${String(++n).padStart(5, '0')}`, ...payload } });
  const t = () => store.read((tx) => tx.gameMinutes());
  /** 执行 fn 并返回游戏时间推进了多少 */
  const spent = async (fn: () => Promise<{ statusCode: number }>) => {
    const before = t();
    await fn();
    return t() - before;
  };
  return { store, app, post, t, spent };
}

describe('行动耗时', () => {
  it('固定行动：修炼 60、休息 120', async () => {
    const g = await game();
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'cultivate' }))).toBe(ACTION_MINUTES.cultivate);
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'rest' }))).toBe(ACTION_MINUTES.rest);
  });
  it('移动：按连线（30 / 60 分钟）', async () => {
    const g = await game();
    expect(await g.spent(() => g.post({ kind: 'move', locationId: YARD }))).toBe(30);
    expect(await g.spent(() => g.post({ kind: 'move', locationId: GATE }))).toBe(30);
    expect(await g.spent(() => g.post({ kind: 'move', locationId: PATH }))).toBe(60);
  });
  it('任务：接取 / 放弃各 10 分钟', async () => {
    const g = await game();
    expect(await g.spent(() => g.post({ kind: 'quest', questId: 'quest_first_steps', op: 'accept' }))).toBe(ACTION_MINUTES.quest);
    expect(await g.spent(() => g.post({ kind: 'quest', questId: 'quest_first_steps', op: 'abandon' }))).toBe(ACTION_MINUTES.quest);
  });
  it('突破 180 分钟（成功与失败都耗时）', async () => {
    const ok = await game({ player: { realmProgress: 100 }, rng: 0 });
    expect(await ok.spent(() => ok.post({ kind: 'breakthrough', pillItemId: null }))).toBe(ACTION_MINUTES.breakthrough);
    const bad = await game({ player: { realmProgress: 100 }, rng: 0.9999 });
    expect(await bad.spent(() => bad.post({ kind: 'breakthrough', pillItemId: null }))).toBe(ACTION_MINUTES.breakthrough);
  });
  it('被拒绝的行动不耗时，状态不变：体力不足、不相邻、封锁、进度未满、冷却中', async () => {
    const g = await game({ player: { stamina: 1 } });
    const before = g.store.read((tx) => tx.player());
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'cultivate' }))).toBe(0);
    expect(await g.spent(() => g.post({ kind: 'move', locationId: YARD }))).toBe(0); // 体力不足
    expect(await g.spent(() => g.post({ kind: 'breakthrough', pillItemId: null }))).toBe(0); // 进度未满
    expect(g.store.read((tx) => tx.player())).toEqual(before);

    const h = await game();
    expect(await h.spent(() => h.post({ kind: 'move', locationId: 'loc_foot_town' }))).toBe(0); // 不相邻
    h.store.transact((tx) => tx.setLocationStatus(PATH, 'blocked', '塌方'));
    expect(await h.spent(() => h.post({ kind: 'move', locationId: PATH }))).toBe(0);
  });
  it('幂等重放不再次耗时；同键异参 409 也不耗时', async () => {
    const g = await game();
    const key = 'clock-replay-0001';
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'cultivate' }, key))).toBe(60);
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'cultivate' }, key))).toBe(0);
    const clash = await g.post({ kind: 'fixed', actionId: 'rest' }, key);
    expect(clash.statusCode).toBe(409);
    expect(await g.spent(() => g.post({ kind: 'fixed', actionId: 'rest' }, key))).toBe(0);
  });
  it('自由输入走同一套耗时；澄清与查看状态不耗时', async () => {
    const g = await game({ keyword: true });
    const free = (input: string) => g.post({ kind: 'free', input });
    expect(await g.spent(() => free('修炼一会儿'))).toBe(60);
    expect(await g.spent(() => free('去练功场'))).toBe(30);
    expect(await g.spent(() => free('查看状态'))).toBe(0);
    expect(await g.spent(() => free('嗯嗯啊啊'))).toBe(0);
  });
  it('响应与日志带上耗时之后的游戏时间；时间只增不减', async () => {
    const g = await game();
    const seen: number[] = [];
    for (const body of [{ kind: 'fixed', actionId: 'cultivate' }, { kind: 'move', locationId: YARD }, { kind: 'fixed', actionId: 'rest' }]) {
      const r = ActionResponseSchema.parse((await g.post(body)).json());
      seen.push(r.log!.gameMinutes!);
      expect(r.log!.gameMinutes).toBe(g.t());
    }
    expect(seen).toEqual([INITIAL_GAME_MINUTES + 60, INITIAL_GAME_MINUTES + 90, INITIAL_GAME_MINUTES + 210]);
    const log = LogResponseSchema.parse((await g.app.inject({ method: 'GET', url: '/api/v1/log' })).json());
    const times = log.entries.map((e) => e.gameMinutes!);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('打招呼耗时', () => {
  it('第一次相识 10 分钟（审计事件的差异包含时钟）；再次打招呼不变化也不耗时', async () => {
    const g = await game();
    const greet = () => g.app.inject({ method: 'POST', url: '/api/v1/world/npcs/npc_gate_guard/greet' });
    expect(await g.spent(greet)).toBe(ACTION_MINUTES.greet);
    expect(await g.spent(greet)).toBe(0);
    const met = g.store.read((tx) => tx.recentLog(10)).filter((e) => e.narrative.includes('相识'));
    expect(met).toHaveLength(1);
    expect(met[0]!.gameMinutes).toBe(INITIAL_GAME_MINUTES + 10);
    // 不在场的人：被拒绝，不耗时
    expect(await g.spent(() => g.app.inject({ method: 'POST', url: '/api/v1/world/npcs/npc_senior_sister/greet' }))).toBe(0);
  });
});

describe('突破冷却用游戏时间', () => {
  it('失败后冷却 = 尝试结束时刻 + 24 游戏小时；现实时间流逝不影响', async () => {
    const g = await game({ player: { realmProgress: 100 }, rng: 0.9999 });
    const t0 = g.t();
    const r = ActionResponseSchema.parse((await g.post({ kind: 'breakthrough', pillItemId: null })).json());
    expect(r.player.breakthroughAvailableAt).toBe(t0 + 180 + BREAKTHROUGH_RULES.cooldownMinutes);
    expect(BREAKTHROUGH_RULES.cooldownMinutes).toBe(24 * 60);
  });
});

describe('放置修炼推进游戏时间', () => {
  async function idle(opts: { player?: Partial<PlayerState>; offline?: Record<string, number> } = {}) {
    const store = createMemoryGameStore({ ...createInitialPlayer(), ...opts.player });
    const time = { t: T0 };
    const app = await buildApp({ store, clock: { now: () => time.t }, offline: opts.offline ?? { thresholdMs: Number.MAX_SAFE_INTEGER } });
    const call = async (path: string) => CultivationResponseSchema.parse((await app.inject({ method: 'POST', url: `/api/v1/cultivation${path}` })).json());
    return { store, time, app, start: () => call('/start'), settle: () => call('/settle'), stop: () => call('/stop'), t: () => store.read((tx) => tx.gameMinutes()) };
  }
  const perTick = IDLE_CULTIVATION.gameMinutesPerTick;

  it('在线挂机不推进游戏时间：结算、停止都不动，收益照常', async () => {
    const s = await idle();
    await s.start();
    for (let i = 0; i < 60; i++) {
      s.time.t += MIN;
      await s.settle();
    }
    const r = await s.stop();
    expect(s.store.read((tx) => tx.player().realmProgress)).toBeGreaterThan(0); // 修炼收益照常
    expect(r.player.realmProgress).toBeGreaterThan(0);
    expect(s.t()).toBe(INITIAL_GAME_MINUTES);
  });
  it('离线回来：这段时间按现实 1 小时 = 1 时辰一次性折算', async () => {
    const s = await idle({ offline: {} });
    await s.start();
    s.time.t += 3 * 60 * MIN; // 离开三小时
    await s.settle();
    expect(s.t() - INITIAL_GAME_MINUTES).toBe(3 * 120);
    expect(perTick * 60).toBe(120);
  });
  it('离线结算之后又在线：不重复计入同一段时间', async () => {
    const s = await idle({ offline: {} });
    await s.start();
    s.time.t += 2 * 60 * MIN;
    await s.settle();
    const t1 = s.t();
    s.time.t += 2 * MIN; // 回来后在线 2 分钟
    await s.settle();
    await s.settle();
    expect(s.t()).toBe(t1);
  });
  it('离线：最多折算 12 现实小时 = 1 个游戏日；超出部分作废', async () => {
    const s = await idle({ offline: {} });
    await s.start();
    s.time.t += 20 * 60 * MIN;
    await s.settle();
    expect(s.t() - INITIAL_GAME_MINUTES).toBe(MINUTES_PER_DAY);
  });
  it('离线途中修炼圆满：只计到圆满为止', async () => {
    const s = await idle({ offline: {}, player: { realmProgress: 99 } });
    await s.start();
    s.time.t += 10 * 60 * MIN;
    const r = await s.settle();
    expect(r.notice).toContain('圆满');
    expect(s.t() - INITIAL_GAME_MINUTES).toBeLessThan(60); // 约 10 片 → 20 游戏分钟
    expect(s.t()).toBeGreaterThan(INITIAL_GAME_MINUTES);
  });
  it('没有修炼就离线：世界不动，不论现实时间过去多久', async () => {
    const s = await idle({ offline: {} });
    s.time.t += 7 * 24 * 60 * MIN;
    await s.settle();
    await s.start();
    await s.stop();
    expect(s.t()).toBe(INITIAL_GAME_MINUTES);
    const w = WorldTimeResponseSchema.parse((await s.app.inject({ method: 'GET', url: '/api/v1/world/time' })).json());
    expect(w.game.minutes).toBe(INITIAL_GAME_MINUTES);
    expect(w.game.label).toBe('第 1 天 · 辰时');
  });
  it('现实时钟回拨：游戏时间仍然只增不减', async () => {
    const s = await idle();
    await s.start();
    s.time.t += 10 * MIN;
    await s.settle();
    const t1 = s.t();
    s.time.t -= 5 * 60 * MIN;
    await s.settle();
    expect(s.t()).toBe(t1);
  });
});

describe('世界时间接口', () => {
  it('随行动更新：日期、时辰与展示文字', async () => {
    const g = await game();
    const read = async () => WorldTimeResponseSchema.parse((await g.app.inject({ method: 'GET', url: '/api/v1/world/time' })).json()).game;
    expect(await read()).toMatchObject({ minutes: INITIAL_GAME_MINUTES, day: 1, shichen: '辰' });
    await g.post({ kind: 'fixed', actionId: 'rest' });
    await g.post({ kind: 'fixed', actionId: 'rest' });
    expect(await read()).toEqual({ minutes: INITIAL_GAME_MINUTES + 240, day: 1, shichen: '午', label: '第 1 天 · 午时' });
    expect(gameDate(INITIAL_GAME_MINUTES + 240).label).toBe('第 1 天 · 午时');
  });
});

describe('存档与旧存档', () => {
  const sqliteGame = () => {
    const d = fresh();
    const s = createSqliteGameStore(d.db, createInitialPlayer());
    return { d, s };
  };
  const exportRaw = (s: GameStore) => JSON.parse(JSON.stringify(s.read((tx) => buildSaveFile(tx.player(), snapshotWorld(tx)))));

  it('legacyCooldown：剩余时间折算为游戏分钟，最多一个冷却期，过期清除', () => {
    const now = T0;
    expect(legacyCooldown(null, now)).toBeNull();
    expect(legacyCooldown(now - 1, now)).toBeNull();
    expect(legacyCooldown(now, now)).toBeNull();
    expect(legacyCooldown(now + 1, now)).toBe(INITIAL_GAME_MINUTES + 1); // 不足 1 分钟向上取整
    expect(legacyCooldown(now + 5 * 60 * MIN, now)).toBe(INITIAL_GAME_MINUTES + 300);
    expect(legacyCooldown(now + 99 * 24 * 60 * MIN, now)).toBe(INITIAL_GAME_MINUTES + BREAKTHROUGH_RULES.cooldownMinutes);
  });
  it('新存档往返：游戏时间与冷却原样保留', () => {
    const a = sqliteGame();
    a.s.transact((tx) => {
      tx.advanceGameClock(2000);
      tx.advanceGameClock(2000);
      tx.savePlayer({ ...tx.player(), breakthroughAvailableAt: tx.gameMinutes() + 700 });
    });
    const raw = exportRaw(a.s);
    expect(raw.world.gameMinutes).toBe(INITIAL_GAME_MINUTES + 4000);
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES + 4000);
    expect(b.s.read((tx) => tx.player().breakthroughAvailableAt)).toBe(INITIAL_GAME_MINUTES + 4700);
  });
  it('旧存档（没有游戏时间）：回到起点，现实时间的冷却折算为剩余时间', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    delete raw.world.gameMinutes;
    raw.player.breakthroughAvailableAt = T0 + 3 * 60 * MIN;
    const b = sqliteGame();
    b.s.transact((tx) => tx.advanceGameClock(999));
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES);
    expect(b.s.read((tx) => tx.player().breakthroughAvailableAt)).toBe(INITIAL_GAME_MINUTES + 180);
  });
  it('v1 存档（只有角色）同样折算；已过期的冷却清除', () => {
    const a = sqliteGame();
    const raw = exportRaw(a.s);
    raw.schemaVersion = 1;
    delete raw.world;
    raw.player.breakthroughAvailableAt = T0 - 1000;
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(raw)), T0);
    expect(b.s.read((tx) => tx.player().breakthroughAvailableAt)).toBeNull();
    expect(b.s.read((tx) => tx.gameMinutes())).toBe(INITIAL_GAME_MINUTES);
  });
  it('导入在审计里留下时钟变化（save.state 的差异包含 gameMinutes）', () => {
    const a = sqliteGame();
    a.s.transact((tx) => tx.advanceGameClock(300));
    const b = sqliteGame();
    importSave(b.d.db, parseSaveFile(JSON.stringify(exportRaw(a.s))), T0);
    const ev = b.d.sqlite.prepare("select after_json a from audit_events where event_type = 'save.state'").get() as { a: string };
    expect(JSON.parse(ev.a).gameMinutes).toBe(INITIAL_GAME_MINUTES + 300);
  });
  it.each([[-1], [1.5], ['5']])('拒绝非法的游戏时间 %s', (bad) => {
    const raw = exportRaw(sqliteGame().s);
    raw.world.gameMinutes = bad;
    expect(() => parseSaveFile(JSON.stringify(raw))).toThrow();
  });
});

describe('迁移：带数据升级到游戏时钟', () => {
  it('旧库的突破冷却（现实毫秒）折算成游戏分钟，过期的清除；时钟种子为起点', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-clock-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const cut = (journal.entries as { tag: string }[]).findIndex((e) => e.tag.includes('game_clock'));
      expect(cut).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, cut);
      writeFileSync(journalPath, JSON.stringify(journal));

      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      const ins = d.sqlite.prepare(
        "insert into player_states (player_id, realm, realm_progress, hp, max_hp, stamina, max_stamina, yuanbao, silver, copper, attributes_json, location_id, location_name, breakthrough_available_at) values (?, 'body_tempering', 0, 100, 100, 50, 50, 0, 0, 0, '{}', 'loc_qingyun_gate', '山门', ?)",
      );
      const now = Date.now();
      for (const [id, v] of [['p_none', null], ['p_expired', now - 60_000], ['p_5h', now + 5 * 3600_000], ['p_far', now + 99 * 24 * 3600_000]] as const) {
        d.sqlite.prepare('insert into players (id, display_name) values (?, ?)').run(id, id);
        ins.run(id, v);
      }
      runMigrations(d.db);
      const cd = (id: string) => (d.sqlite.prepare('select breakthrough_available_at v from player_states where player_id = ?').get(id) as { v: number | null }).v;
      expect(cd('p_none')).toBeNull();
      expect(cd('p_expired')).toBeNull();
      expect(Math.abs(cd('p_5h')! - (INITIAL_GAME_MINUTES + 300))).toBeLessThanOrEqual(1);
      expect(cd('p_far')).toBe(INITIAL_GAME_MINUTES + BREAKTHROUGH_RULES.cooldownMinutes);
      expect((d.sqlite.prepare("select minutes m from game_clock where id = 'main'").get() as { m: number }).m).toBe(INITIAL_GAME_MINUTES);
      d.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
