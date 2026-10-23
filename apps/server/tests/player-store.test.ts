import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ActionResponseSchema, PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import { createInitialPlayer, resolveFixedAction } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMemoryPlayerStore, type PlayerStore } from '../src/modules/player/store.js';
import { createSqlitePlayerStore, writePlayerState } from '../src/modules/player/sqlite-store.js';
import { buildSaveFile, parseSaveFile } from '../src/modules/player/save-file.js';

const sqliteStore = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return createSqlitePlayerStore(d.db);
};

const impls: [string, () => PlayerStore][] = [
  ['内存', () => createMemoryPlayerStore()],
  ['SQLite', sqliteStore],
];

const spend = (p: PlayerState): PlayerState => {
  const r = resolveFixedAction(p, 'cultivate');
  if (!r.ok) throw new Error(r.message);
  return r.player;
};

describe.each(impls)('PlayerStore 契约：%s', (_name, make) => {
  it('初始为种子角色，版本 0', () => {
    expect(make().get()).toEqual(createInitialPlayer());
  });

  it('commit 保存新状态并将版本加一', () => {
    const s = make();
    const saved = s.commit(spend(s.get()), 0);
    expect(saved.version).toBe(1);
    expect(saved.stamina).toBe(40);
    expect(s.get()).toEqual(saved);
  });

  it('过期版本被拒绝（CONFLICT），状态不变', () => {
    const s = make();
    s.commit(spend(s.get()), 0);
    const before = s.get();
    expect(() => s.commit(spend(before), 0)).toThrow(/已变化/);
    expect(s.get()).toEqual(before);
  });

  it('非法状态被拒绝，存档不变', () => {
    const s = make();
    const bad = { ...s.get(), hp: 9999 } as PlayerState;
    expect(() => s.commit(bad, 0)).toThrow();
    expect(s.get().version).toBe(0);
  });

  it('get 返回副本，修改不会影响存档', () => {
    const s = make();
    const a = s.get();
    a.currency.silver = 12345;
    expect(s.get().currency.silver).toBe(10);
  });

  it('可保存后天境界与内力', () => {
    const s = make();
    const next = { ...s.get(), realm: 'houtian' as const, neili: { current: 6, max: 60 } };
    expect(s.commit(next, 0).neili).toEqual({ current: 6, max: 60 });
  });
});

describe('持久化（文件数据库）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const open = (file: string) => {
    const d = openDatabase(file);
    runMigrations(d.db);
    return { d, store: createSqlitePlayerStore(d.db) };
  };

  it('重启后状态保留，重复初始化不覆盖已有存档', () => {
    const file = join(dir, 'nested', 'a.sqlite'); // 目录自动创建
    const first = open(file);
    first.store.commit(spend(first.store.get()), 0);
    first.d.close();

    const second = open(file);
    expect(second.store.get().stamina).toBe(40);
    expect(second.store.get().version).toBe(1);
    second.d.close();
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
    expect(() => store.get()).toThrow();
    d.close();
  });
});

describe('存档导出 / 导入', () => {
  it('往返一致', () => {
    const d = openDatabase(':memory:');
    runMigrations(d.db);
    const s = createSqlitePlayerStore(d.db);
    s.commit(spend(s.get()), 0);
    const text = JSON.stringify(buildSaveFile(s.get()));

    const d2 = openDatabase(':memory:');
    runMigrations(d2.db);
    const s2 = createSqlitePlayerStore(d2.db);
    writePlayerState(d2.db, parseSaveFile(text).player);
    expect(s2.get()).toEqual(s.get());
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
