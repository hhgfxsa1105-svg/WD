import { describe, expect, it } from 'vitest';
import { REALMS } from '@jhz/contracts';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { DB_REALMS } from '../src/db/schema.js';

const fresh = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return d;
};

const insertPlayer = (d: ReturnType<typeof fresh>) =>
  d.sqlite.prepare("insert into players (id, display_name) values ('p1', '甲')").run();

const baseState = {
  player_id: 'p1', realm: 'body_tempering', realm_progress: 0, hp: 10, max_hp: 10, stamina: 5, max_stamina: 5,
  neili_current: null as number | null, neili_max: null as number | null, yuanbao: 0, silver: 0, copper: 0,
  attributes_json: '{}', location_id: 'l', location_name: 'n', version: 0,
};
const insertState = (d: ReturnType<typeof fresh>, patch: Partial<typeof baseState> = {}) => {
  const row = { ...baseState, ...patch };
  const cols = Object.keys(row);
  return d.sqlite
    .prepare(`insert into player_states (${cols.join(',')}) values (${cols.map((c) => '@' + c).join(',')})`)
    .run(row);
};

describe('迁移', () => {
  it('空库可迁移到最新版本，表齐全', () => {
    const d = fresh();
    const tables = d.sqlite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['players', 'player_states', '__drizzle_migrations']));
  });

  it('重复执行幂等，不重复应用', () => {
    const d = fresh();
    const count = () => (d.sqlite.prepare('select count(*) c from __drizzle_migrations').get() as { c: number }).c;
    const before = count();
    runMigrations(d.db);
    runMigrations(d.db);
    expect(count()).toBe(before);
  });

  it('schema 内联的境界列表与契约一致', () => {
    expect([...DB_REALMS]).toEqual([...REALMS]);
  });
});

describe('数据库约束（E-06）', () => {
  it('合法行可插入', () => {
    const d = fresh();
    insertPlayer(d);
    expect(() => insertState(d)).not.toThrow();
  });

  it.each([
    ['未知境界', { realm: 'god' }],
    ['进度超过 100', { realm_progress: 101 }],
    ['进度为负', { realm_progress: -1 }],
    ['hp 超过 max_hp', { hp: 11 }],
    ['hp 为负', { hp: -1 }],
    ['体力超过上限', { stamina: 6 }],
    ['银两为负', { silver: -1 }],
    ['元宝为负', { yuanbao: -1 }],
    ['铜钱为负', { copper: -1 }],
    ['内力只有一半为空', { neili_current: 1, neili_max: null }],
    ['内力超过上限', { neili_current: 5, neili_max: 3 }],
    ['版本为负', { version: -1 }],
  ])('拒绝：%s', (_n, patch) => {
    const d = fresh();
    insertPlayer(d);
    expect(() => insertState(d, patch)).toThrow(/CHECK constraint/);
  });

  it('外键：状态必须属于已存在的玩家', () => {
    const d = fresh();
    expect(() => insertState(d)).toThrow(/FOREIGN KEY/);
  });

  it('主键：同一玩家不能有两条状态', () => {
    const d = fresh();
    insertPlayer(d);
    insertState(d);
    expect(() => insertState(d)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('删除玩家时级联删除状态', () => {
    const d = fresh();
    insertPlayer(d);
    insertState(d);
    d.sqlite.prepare("delete from players where id='p1'").run();
    expect((d.sqlite.prepare('select count(*) c from player_states').get() as { c: number }).c).toBe(0);
  });
});
