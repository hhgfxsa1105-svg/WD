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
    const text = JSON.stringify(buildSaveFile(s.read((tx) => tx.player())));

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
