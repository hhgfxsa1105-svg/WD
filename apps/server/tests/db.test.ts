import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { ACTION_KINDS, ACTION_STATUSES, REALMS } from '@jhz/contracts';
import { MIGRATIONS_DIR, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { DB_ACTION_KINDS, DB_ACTION_STATUSES, DB_REALMS } from '../src/db/schema.js';

const fresh = () => {
  const d = openDatabase(':memory:');
  runMigrations(d.db);
  return d;
};

const insertPlayer = (d: ReturnType<typeof fresh>) =>
  d.sqlite.prepare("insert into players (id, display_name) values ('p1', '甲')").run();

const baseState = {
  player_id: 'p1', realm: 'body_tempering', realm_progress: 0, hp: 10, max_hp: 10, stamina: 5, max_stamina: 5,
  neili_current: null as number | null, neili_max: null as number | null, breakthrough_available_at: null as number | null, yuanbao: 0, silver: 0, copper: 0,
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
    ['冷却时间为负', { breakthrough_available_at: -1 }],
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

describe('带数据升级（已有存档）', () => {
  it('从旧版本迁移到最新：数据保留，新增列为 NULL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jhz-mig-'));
    try {
      // 只保留第一个迁移，模拟旧版本数据库
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      const journalPath = join(tmp, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const full = journal.entries;
      journal.entries = full.slice(0, 1);
      writeFileSync(journalPath, JSON.stringify(journal));

      const d = openDatabase(':memory:');
      migrate(d.db, { migrationsFolder: tmp });
      d.sqlite.prepare("insert into players (id, display_name) values ('p1', '甲')").run();
      d.sqlite
        .prepare(
          `insert into player_states (player_id, realm, realm_progress, hp, max_hp, stamina, max_stamina, yuanbao, silver, copper, attributes_json, location_id, location_name, version)
           values ('p1','body_tempering',33,90,100,20,50,1,2,3,'{}','l','n',7)`,
        )
        .run();

      runMigrations(d.db); // 升级到最新
      const row = d.sqlite.prepare('select * from player_states').get() as Record<string, unknown>;
      expect(row.realm_progress).toBe(33);
      expect(row.version).toBe(7);
      expect(row.copper).toBe(3);
      expect(row.breakthrough_available_at).toBeNull();
      expect(() => d.sqlite.prepare("update player_states set breakthrough_available_at = -5").run()).toThrow(/CHECK/);
      expect(full.length).toBeGreaterThan(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('背包与修炼任务约束', () => {
  const withPlayer = () => {
    const d = fresh();
    insertPlayer(d);
    return d;
  };
  const addItem = (d: ReturnType<typeof fresh>, qty: number, item = 'pill_breakthrough_fan') =>
    d.sqlite.prepare('insert into inventory (player_id, item_id, quantity) values (?, ?, ?)').run('p1', item, qty);
  const addJob = (d: ReturnType<typeof fresh>, id: string, status: string, started = 100, settled = 100) =>
    d.sqlite
      .prepare('insert into cultivation_jobs (id, player_id, method_id, status, started_at, last_settled_at) values (?,?,?,?,?,?)')
      .run(id, 'p1', 'basic_breathing', status, started, settled);

  it('库存：数量范围、主键唯一、外键', () => {
    const d = withPlayer();
    expect(() => addItem(d, 1)).not.toThrow();
    expect(() => addItem(d, 1)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => addItem(d, -1, 'x')).toThrow(/CHECK/);
    expect(() => addItem(d, 10_000, 'y')).toThrow(/CHECK/);
    expect(() => d.sqlite.prepare("insert into inventory values ('ghost','x',1,0)").run()).toThrow(/FOREIGN KEY/);
  });

  it('修炼任务：状态枚举、时间顺序', () => {
    const d = withPlayer();
    expect(() => addJob(d, 'j0', 'paused')).toThrow(/CHECK/);
    expect(() => addJob(d, 'j1', 'running', 200, 100)).toThrow(/CHECK/);
    expect(() => addJob(d, 'j2', 'running', 100, 100)).not.toThrow();
  });

  it('同一玩家只能有一个进行中的修炼，已停止的可以有多个', () => {
    const d = withPlayer();
    addJob(d, 'a', 'running');
    expect(() => addJob(d, 'b', 'running')).toThrow(/UNIQUE/);
    expect(() => addJob(d, 'c', 'stopped')).not.toThrow();
    expect(() => addJob(d, 'd', 'stopped')).not.toThrow();
  });

  it('删除玩家时级联删除库存与任务', () => {
    const d = withPlayer();
    addItem(d, 1);
    addJob(d, 'a', 'running');
    d.sqlite.prepare("delete from players where id='p1'").run();
    expect((d.sqlite.prepare('select count(*) c from inventory').get() as { c: number }).c).toBe(0);
    expect((d.sqlite.prepare('select count(*) c from cultivation_jobs').get() as { c: number }).c).toBe(0);
  });
});

describe('离线与世界时钟的数据结构', () => {
  it('cultivation_jobs.last_checked_at 可为空（旧数据）', () => {
    const d = fresh();
    insertPlayer(d);
    d.sqlite
      .prepare("insert into cultivation_jobs (id, player_id, method_id, status, started_at, last_settled_at) values ('j','p1','m','running',1,1)")
      .run();
    expect((d.sqlite.prepare('select last_checked_at v from cultivation_jobs').get() as { v: number | null }).v).toBeNull();
  });

  it('world_clock：高水位非负、主键唯一', () => {
    const d = fresh();
    d.sqlite.prepare("insert into world_clock (id, high_water_at) values ('main', 5)").run();
    expect(() => d.sqlite.prepare("insert into world_clock (id, high_water_at) values ('main', 6)").run()).toThrow(/UNIQUE|PRIMARY/);
    expect(() => d.sqlite.prepare("insert into world_clock (id, high_water_at) values ('x', -1)").run()).toThrow(/CHECK/);
  });
});

describe('行动与审计表约束', () => {
  const d0 = () => {
    const d = fresh();
    insertPlayer(d);
    return d;
  };
  const addAction = (d: ReturnType<typeof fresh>, id: string, key: string, over: Record<string, unknown> = {}) => {
    const row = { id, player_id: 'p1', idempotency_key: key, kind: 'fixed', fingerprint: 'f', status: 'COMPLETED', response_json: '{}', created_at: 1, ...over };
    const cols = Object.keys(row);
    return d.sqlite.prepare(`insert into actions (${cols.join(',')}) values (${cols.map((c) => '@' + c).join(',')})`).run(row);
  };
  const addEvent = (d: ReturnType<typeof fresh>, over: Record<string, unknown> = {}) => {
    const row = { id: crypto.randomUUID(), actor_id: 'p1', action_id: null, event_type: 'x', before_json: null, after_json: null, log_json: null, created_at: 1, ...over };
    const cols = Object.keys(row);
    return d.sqlite.prepare(`insert into audit_events (${cols.join(',')}) values (${cols.map((c) => '@' + c).join(',')})`).run(row);
  };

  it('schema 内联的状态与种类与契约一致', () => {
    expect([...DB_ACTION_STATUSES]).toEqual([...ACTION_STATUSES]);
    expect([...DB_ACTION_KINDS]).toEqual([...ACTION_KINDS]);
  });

  it('幂等键在同一玩家内唯一，长度 8–64', () => {
    const d = d0();
    expect(() => addAction(d, 'a1', 'idem-key-0001')).not.toThrow();
    expect(() => addAction(d, 'a2', 'idem-key-0001')).toThrow(/UNIQUE/);
    expect(() => addAction(d, 'a3', 'short')).toThrow(/CHECK/);
    expect(() => addAction(d, 'a4', 'x'.repeat(65))).toThrow(/CHECK/);
  });

  it.each([
    ['状态非法', { status: 'DONE' }],
    ['种类非法', { kind: 'free' }],
    ['响应不是合法 JSON', { response_json: 'not json' }],
  ])('行动表拒绝：%s', (_n, over) => {
    const d = d0();
    expect(() => addAction(d, 'a1', 'idem-key-0001', over)).toThrow(/CHECK/);
  });

  it('审计事件：类型非空、JSON 合法、外键、id 唯一；seq 单调递增', () => {
    const d = d0();
    expect(() => addEvent(d, { event_type: '' })).toThrow(/CHECK/);
    expect(() => addEvent(d, { before_json: '{bad' })).toThrow(/CHECK/);
    expect(() => addEvent(d, { log_json: 'nope' })).toThrow(/CHECK/);
    expect(() => addEvent(d, { actor_id: 'ghost' })).toThrow(/FOREIGN KEY/);
    expect(() => addEvent(d, { action_id: 'ghost' })).toThrow(/FOREIGN KEY/);
    expect(() => addEvent(d, { id: 'dup' })).not.toThrow();
    expect(() => addEvent(d, { id: 'dup' })).toThrow(/UNIQUE/);
    const seqs = (d.sqlite.prepare('select seq from audit_events order by seq').all() as { seq: number }[]).map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('删除行动后，审计事件保留且 action_id 置空；删除玩家则级联删除', () => {
    const d = d0();
    addAction(d, 'a1', 'idem-key-0001');
    addEvent(d, { action_id: 'a1' });
    d.sqlite.prepare("delete from actions where id='a1'").run();
    expect(d.sqlite.prepare('select action_id from audit_events').get()).toEqual({ action_id: null });
    d.sqlite.prepare("delete from players where id='p1'").run();
    expect((d.sqlite.prepare('select count(*) c from audit_events').get() as { c: number }).c).toBe(0);
  });
});
