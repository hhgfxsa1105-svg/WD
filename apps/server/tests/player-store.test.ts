import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ActionResponseSchema, PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import { createInitialPlayer, resolveFixedAction } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore, ensureSeed, writePlayerState } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';

const sqliteStore = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return createSqliteGameStore(d.db);
};

const impls: [string, () => GameStore][] = [
  ['内存', () => createMemoryGameStore()],
  ['SQLite', sqliteStore],
];

const spend = (p: PlayerState): PlayerState => {
  const r = resolveFixedAction(p, 'cultivate');
  if (!r.ok) throw new Error(r.message);
  return r.player;
};
const PILL = 'pill_breakthrough_fan';
const qty = (s: GameStore, id = PILL) => s.read((tx) => tx.inventory().find((i) => i.itemId === id)?.quantity ?? 0);
const job = (id: string, over = {}) => ({ id, methodId: 'basic_breathing', status: 'running' as const, startedAt: 1000, lastSettledAt: 1000, lastCheckedAt: 1000, ...over });

describe.each(impls)('GameStore 契约：%s', (_name, make) => {
  it('初始为种子角色（版本 0）、1 枚凡阶突破丹、无修炼任务', () => {
    const s = make();
    expect(s.read((tx) => tx.player())).toEqual(createInitialPlayer());
    expect(qty(s)).toBe(1);
    expect(s.read((tx) => tx.runningJob())).toBeNull();
  });

  it('savePlayer 保存新状态并将版本加一', () => {
    const s = make();
    const saved = s.transact((tx) => tx.savePlayer(spend(tx.player())));
    expect(saved.version).toBe(1);
    expect(saved.stamina).toBe(40);
    expect(s.read((tx) => tx.player())).toEqual(saved);
  });

  it('使用过期对象保存被拒绝（CONFLICT），状态不变', () => {
    const s = make();
    const stale = s.read((tx) => tx.player());
    s.transact((tx) => tx.savePlayer(spend(tx.player())));
    expect(() => s.transact((tx) => tx.savePlayer(spend(stale)))).toThrow(/已变化/);
    expect(s.read((tx) => tx.player().version)).toBe(1);
  });

  it('非法状态被拒绝，存档不变', () => {
    const s = make();
    expect(() => s.transact((tx) => tx.savePlayer({ ...tx.player(), hp: 9999 } as PlayerState))).toThrow();
    expect(s.read((tx) => tx.player().version)).toBe(0);
  });

  it('read 返回副本，修改不会影响存档', () => {
    const s = make();
    const a = s.read((tx) => tx.player());
    a.currency.silver = 12345;
    expect(s.read((tx) => tx.player().currency.silver)).toBe(10);
  });

  it('物品：扣除、增加、不足被拒绝、上限 9999、数量 0 不显示', () => {
    const s = make();
    s.transact((tx) => tx.addItem(PILL, 4));
    expect(qty(s)).toBe(5);
    s.transact((tx) => tx.takeItem(PILL, 5));
    expect(qty(s)).toBe(0);
    expect(s.read((tx) => tx.inventory())).toEqual([]);
    expect(() => s.transact((tx) => tx.takeItem(PILL, 1))).toThrow(/不足/);
    expect(() => s.transact((tx) => tx.takeItem(PILL, 0))).toThrow();
    expect(() => s.transact((tx) => tx.addItem(PILL, 10_000))).toThrow(/上限/);
    expect(qty(s)).toBe(0);
  });

  it('事务原子性：中途抛错则扣除物品与角色变更一并回滚', () => {
    const s = make();
    expect(() =>
      s.transact((tx) => {
        tx.takeItem(PILL, 1);
        tx.savePlayer(spend(tx.player()));
        tx.saveJob(job('j1'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(qty(s)).toBe(1);
    expect(s.read((tx) => tx.player())).toEqual(createInitialPlayer());
    expect(s.read((tx) => tx.runningJob())).toBeNull();
  });

  it('修炼任务：保存、更新，同时只能有一个进行中', () => {
    const s = make();
    s.transact((tx) => tx.saveJob(job('j1')));
    expect(s.read((tx) => tx.runningJob())).toMatchObject({ id: 'j1', lastSettledAt: 1000 });
    s.transact((tx) => tx.saveJob(job('j1', { lastSettledAt: 5000 })));
    expect(s.read((tx) => tx.runningJob()!.lastSettledAt)).toBe(5000);
    expect(() => s.transact((tx) => tx.saveJob(job('j2')))).toThrow();
    s.transact((tx) => tx.saveJob(job('j1', { status: 'stopped', lastSettledAt: 5000 })));
    expect(s.read((tx) => tx.runningJob())).toBeNull();
    expect(() => s.transact((tx) => tx.saveJob(job('j2')))).not.toThrow();
  });

  const stored = (tx: Parameters<Parameters<GameStore['read']>[0]>[0], id: string, key: string) => ({
    id,
    kind: 'fixed' as const,
    idempotencyKey: key,
    fingerprint: 'fixed:rest',
    status: 'COMPLETED' as const,
    createdAt: 1,
    response: { actionId: id, status: 'COMPLETED' as const, narrative: 'n', changes: [], breakthrough: null, log: null, ai: null, player: tx.player() },
  });
  const logPayload = { type: 'system' as const, narrative: '日志', changes: [], breakthrough: null, idle: null, note: null };

  it('行动记录：按幂等键与 ID 查询；同一幂等键不能用于另一个行动；同 ID 可更新', () => {
    const s = make();
    expect(s.read((tx) => tx.findActionByKey('idem-key-0001'))).toBeNull();
    s.transact((tx) => tx.saveAction(stored(tx, 'a1', 'idem-key-0001')));
    expect(s.read((tx) => tx.findActionByKey('idem-key-0001'))).toMatchObject({ id: 'a1', fingerprint: 'fixed:rest' });
    expect(s.read((tx) => tx.getAction('a1'))?.idempotencyKey).toBe('idem-key-0001');
    expect(s.read((tx) => tx.getAction('nope'))).toBeNull();
    expect(() => s.transact((tx) => tx.saveAction(stored(tx, 'a2', 'idem-key-0001')))).toThrow();
    s.transact((tx) => tx.saveAction({ ...stored(tx, 'a1', 'idem-key-0001'), response: { ...stored(tx, 'a1', 'idem-key-0001').response, narrative: '更新' } }));
    expect(s.read((tx) => tx.getAction('a1'))?.response.narrative).toBe('更新');
  });

  it('审计与日志：序号递增、只有带日志的事件进入日志、按时间正序、limit 取最近', () => {
    const s = make();
    s.transact((tx) => tx.saveAction(stored(tx, 'a1', 'idem-key-0001')));
    const r1 = s.transact((tx) => tx.appendEvent({ actionId: 'a1', eventType: 't.one', before: { x: 1 }, after: { x: 2 }, at: 10, log: { ...logPayload, narrative: '一' } }));
    const none = s.transact((tx) => tx.appendEvent({ actionId: 'a1', eventType: 't.nolog', before: null, after: null, at: 11, log: null }));
    const r3 = s.transact((tx) => tx.appendEvent({ actionId: null, eventType: 't.three', before: null, after: { y: 1 }, at: 12, log: { ...logPayload, narrative: '三' } }));
    expect(none).toBeNull();
    expect(r1!.id).toBeLessThan(r3!.id);
    expect(r1).toMatchObject({ at: 10, narrative: '一' });
    expect(s.read((tx) => tx.recentLog(10)).map((e) => e.narrative)).toEqual(['一', '三']);
    expect(s.read((tx) => tx.recentLog(1)).map((e) => e.narrative)).toEqual(['三']);
    const evs = s.read((tx) => tx.eventsForAction('a1'));
    expect(evs.map((e) => e.eventType)).toEqual(['t.one', 't.nolog']);
    expect(evs[0]).toMatchObject({ before: { x: 1 }, after: { x: 2 }, at: 10, actionId: 'a1' });
  });

  it('事务回滚连同行动、审计、日志一起撤销', () => {
    const s = make();
    expect(() =>
      s.transact((tx) => {
        tx.saveAction(stored(tx, 'a1', 'idem-key-0001'));
        tx.appendEvent({ actionId: 'a1', eventType: 'x', before: null, after: null, at: 1, log: logPayload });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.read((tx) => tx.findActionByKey('idem-key-0001'))).toBeNull();
    expect(s.read((tx) => tx.recentLog(10))).toEqual([]);
  });

  it('AI 调用记录：预占、结束、按日计数、按时间倒序；失败与未结束也计数', () => {
    const s = make();
    const e = { actionId: null, purpose: 'parse' as const, provider: 'mock', model: 'm', requestChars: 5 };
    const a = s.aiLog.reserve({ ...e, day: '2026-10-23', at: 1 });
    const b = s.aiLog.reserve({ ...e, day: '2026-10-23', at: 2 });
    s.aiLog.reserve({ ...e, day: '2026-10-24', at: 3 });
    expect(s.aiLog.usedOn('2026-10-23')).toBe(2);
    expect(s.aiLog.usedOn('2026-10-24')).toBe(1);
    expect(s.aiLog.usedOn('2026-10-25')).toBe(0);
    s.aiLog.finish(a, { status: 'ok', errorKind: null, attempts: 1, latencyMs: 12, promptTokens: 1, completionTokens: 2, totalTokens: 3, responseChars: 9 });
    s.aiLog.finish(b, { status: 'error', errorKind: 'TIMEOUT', attempts: 0, latencyMs: 30, promptTokens: null, completionTokens: null, totalTokens: null, responseChars: null });
    const recent = s.aiLog.recent(10);
    expect(recent.map((r) => r.createdAt)).toEqual([3, 2, 1]);
    expect(recent.find((r) => r.id === a)).toMatchObject({ status: 'ok', totalTokens: 3, latencyMs: 12 });
    expect(recent.find((r) => r.id === b)).toMatchObject({ status: 'error', errorKind: 'TIMEOUT' });
    expect(s.aiLog.usedOn('2026-10-23')).toBe(2);
    expect(s.aiLog.recent(1)).toHaveLength(1);
  });

  it('可保存后天境界与内力', () => {
    const s = make();
    const saved = s.transact((tx) => tx.savePlayer({ ...tx.player(), realm: 'houtian', neili: { current: 6, max: 60 } }));
    expect(saved.neili).toEqual({ current: 6, max: 60 });
  });
});

describe('持久化（文件数据库）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const open = (file: string) => {
    const d = openDatabase(file);
    runMigrations(d.db);
    return { d, store: createSqliteGameStore(d.db) };
  };

  it('重启后角色、库存与修炼任务保留；重复初始化不覆盖也不补发已用掉的丹药', () => {
    const file = join(dir, 'nested', 'a.sqlite'); // 目录自动创建
    const first = open(file);
    first.store.transact((tx) => {
      tx.savePlayer(spend(tx.player()));
      tx.takeItem(PILL, 1);
      tx.saveJob(job('persist-1', { lastSettledAt: 4242 }));
    });
    first.d.close();

    const second = open(file);
    expect(second.store.read((tx) => tx.player().stamina)).toBe(40);
    expect(second.store.read((tx) => tx.player().version)).toBe(1);
    expect(qty(second.store)).toBe(0); // 丹药已用掉，不会因重启重新发放
    expect(second.store.read((tx) => tx.runningJob())).toMatchObject({ id: 'persist-1', lastSettledAt: 4242 });
    second.d.close();
  });

  it('旧存档（没有库存行）升级后补发一次初始库存', () => {
    const d = openDatabase(':memory:');
    runMigrations(d.db);
    ensureSeed(d.db);
    d.sqlite.prepare('delete from inventory').run();
    const store = createSqliteGameStore(d.db);
    expect(qty(store)).toBe(1);
  });

  it('API 层：行动后重建应用与数据库，状态仍在', async () => {
    const file = join(dir, 'b.sqlite');
    const a = open(file);
    const app1 = await buildApp({ store: a.store });
    const res = await app1.inject({
      method: 'POST',
      url: '/api/v1/actions',
      payload: { kind: 'fixed', idempotencyKey: 'persist-key-0001', actionId: 'cultivate' },
    });
    const done = ActionResponseSchema.parse(res.json());
    await app1.close();
    a.d.close();

    const b = open(file);
    const app2 = await buildApp({ store: b.store });
    const state = PlayerStateSchema.parse((await app2.inject({ method: 'GET', url: '/api/v1/player/state' })).json());
    expect(state).toEqual(done.player);
    await app2.close();
    b.d.close();
  });

  it('损坏的存档不会进入游戏（读取时校验）', () => {
    const file = join(dir, 'c.sqlite');
    const { d, store } = open(file);
    d.sqlite.pragma('ignore_check_constraints = ON');
    d.sqlite.prepare("update player_states set attributes_json = '{\"spirit\": 1}'").run();
    expect(() => store.read((tx) => tx.player())).toThrow();
    d.close();
  });
});

describe('存档导出 / 导入', () => {
  it('往返一致', () => {
    const d = openDatabase(':memory:');
    runMigrations(d.db);
    const s = createSqliteGameStore(d.db);
    s.transact((tx) => tx.savePlayer(spend(tx.player())));
    const text = JSON.stringify(buildSaveFile(...s.read((tx) => [tx.player(), { npcs: tx.npcs(), relationships: tx.relationships() }] as const)));

    const d2 = openDatabase(':memory:');
    runMigrations(d2.db);
    const s2 = createSqliteGameStore(d2.db);
    writePlayerState(d2.db, parseSaveFile(text).player);
    expect(s2.read((tx) => tx.player())).toEqual(s.read((tx) => tx.player()));
  });

  it.each([
    ['非 JSON', 'not json'],
    ['缺 format', JSON.stringify({ schemaVersion: 1, exportedAt: 'x', player: createInitialPlayer() })],
    ['玩家数据越界', JSON.stringify({ format: 'jianghu-save', schemaVersion: 1, exportedAt: 'x', player: { ...createInitialPlayer(), hp: 99999 } })],
    ['含未知字段', JSON.stringify({ format: 'jianghu-save', schemaVersion: 1, exportedAt: 'x', player: createInitialPlayer(), extra: 1 })],
  ])('拒绝非法存档文件：%s', (_n, text) => {
    expect(() => parseSaveFile(text)).toThrow();
  });
});
