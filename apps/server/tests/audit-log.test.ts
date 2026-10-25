import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ActionResponseSchema,
  AuditActionResponseSchema,
  CultivationResponseSchema,
  ErrorResponseSchema,
  LogResponseSchema,
  type ActionResponse,
  type PlayerState,
} from '@jhz/contracts';
import { createInitialPlayer, fixedRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase, type Database_ } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import type { OfflinePolicy } from '../src/modules/cultivation/service.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const H = 60 * MIN;
const PILL = 'pill_breakthrough_fan';
const ONLINE: Partial<OfflinePolicy> = { thresholdMs: Number.MAX_SAFE_INTEGER };
const key = (n: number) => `audit-key-${String(n).padStart(4, '0')}`;

async function setup(opts: { store?: GameStore; player?: PlayerState; rng?: number; offline?: Partial<OfflinePolicy> } = {}) {
  const store = opts.store ?? createMemoryGameStore(opts.player);
  const time = { t: T0 };
  const app = await buildApp({ store, clock: { now: () => time.t }, rng: fixedRng(opts.rng ?? 0), offline: opts.offline ?? ONLINE });
  const act = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/actions', payload: payload as object });
  const cultivate = (n: number) => act({ kind: 'fixed', idempotencyKey: key(n), actionId: 'cultivate' });
  const rest = (n: number) => act({ kind: 'fixed', idempotencyKey: key(n), actionId: 'rest' });
  const bt = (n: number, pill: string | null = null) => act({ kind: 'breakthrough', idempotencyKey: key(n), pillItemId: pill });
  const audit = async (id: string, ip?: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/v1/audit/actions/${id}`, remoteAddress: ip });
    return { status: r.statusCode, body: r.json() as unknown };
  };
  const log = async (q = '') => LogResponseSchema.parse((await app.inject({ method: 'GET', url: `/api/v1/log${q}` })).json()).entries;
  const cult = async (op: 'start' | 'settle' | 'stop') =>
    CultivationResponseSchema.parse((await app.inject({ method: 'POST', url: `/api/v1/cultivation/${op}` })).json());
  return { app, store, time, act, cultivate, rest, bt, audit, log, cult };
}
const parse = (r: { json(): unknown }): ActionResponse => ActionResponseSchema.parse(r.json());

describe('审计事件：前后差异与实际一致', () => {
  it('固定行动：只记录发生变化的字段，且与返回的最新状态吻合', async () => {
    const s = await setup();
    const res = parse(await s.cultivate(1));
    const { status, body } = await s.audit(res.actionId);
    expect(status).toBe(200);
    const a = AuditActionResponseSchema.parse(body);
    expect(a.action).toMatchObject({ id: res.actionId, kind: 'fixed', status: 'COMPLETED', idempotencyKey: key(1) });
    expect(a.events).toHaveLength(1);
    const ev = a.events[0]!;
    expect(ev.eventType).toBe('action.cultivate');
    expect(ev.actionId).toBe(res.actionId);
    expect(ev.at).toBe(T0);
    expect(ev.before).toEqual({ stamina: 50, realmProgress: 0, version: 0 });
    expect(ev.after).toEqual({ stamina: res.player.stamina, realmProgress: res.player.realmProgress, version: 1 });
    expect(ev.after).not.toHaveProperty('displayName'); // 未变化的字段不记录
  });

  it('突破：同时记录境界、上限与丹药数量的变化', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realmProgress: 100 }, rng: 0 });
    const res = parse(await s.bt(1, PILL));
    const ev = AuditActionResponseSchema.parse((await s.audit(res.actionId)).body).events[0]!;
    expect(ev.eventType).toBe('action.breakthrough');
    expect(ev.before).toMatchObject({ realm: 'body_tempering', realmProgress: 100, maxHp: 100, inventory: { [PILL]: 1 } });
    expect(ev.after).toMatchObject({ realm: 'opening', realmProgress: 0, maxHp: 130, inventory: { [PILL]: 0 } });
  });

  it('失败的行动不留下任何残余：没有行动记录、没有审计事件、没有日志，丹药不变', async () => {
    const s = await setup(); // 进度未满，突破会被拒绝
    const r = await s.bt(1, PILL);
    expect(r.statusCode).toBe(422);
    expect(await s.log()).toEqual([]);
    expect(s.store.read((tx) => tx.findActionByKey(key(1)))).toBeNull();
    expect(s.store.read((tx) => tx.inventory().find((i) => i.itemId === PILL)?.quantity)).toBe(1);
    // 同一个幂等键还可以正常使用（失败不占用）
    expect((await s.rest(1)).statusCode).toBe(200);
  });

  it('幂等重试：回放首次结果与日志，不产生新的审计事件或日志', async () => {
    const s = await setup();
    const a = parse(await s.cultivate(5));
    const b = parse(await s.cultivate(5));
    expect(b).toEqual(a);
    expect(b.log).not.toBeNull();
    expect(AuditActionResponseSchema.parse((await s.audit(a.actionId)).body).events).toHaveLength(1);
    expect(await s.log()).toHaveLength(1);
  });

  it('并发 5 路同一幂等键：只有一个行动、一个审计事件、一条日志', async () => {
    const s = await setup();
    const rs = await Promise.all(Array.from({ length: 5 }, () => s.cultivate(9)));
    const ids = new Set(rs.map((r) => parse(r).actionId));
    expect(ids.size).toBe(1);
    expect(await s.log()).toHaveLength(1);
    expect(AuditActionResponseSchema.parse((await s.audit([...ids][0]!)).body).events).toHaveLength(1);
  });

  it('同一幂等键换了参数：409，且不产生任何记录', async () => {
    const s = await setup();
    await s.cultivate(3);
    const r = await s.rest(3);
    expect(r.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(r.json()).code).toBe('CONFLICT');
    expect(await s.log()).toHaveLength(1);
  });
});

describe('内部审计接口', () => {
  it('未知行动 404；非本机访问 403', async () => {
    const s = await setup();
    const res = parse(await s.cultivate(1));
    expect((await s.audit('no-such-id')).status).toBe(404);
    const remote = await s.audit(res.actionId, '10.1.2.3');
    expect(remote.status).toBe(403);
    expect(ErrorResponseSchema.parse(remote.body).code).toBe('FORBIDDEN');
    expect((await s.audit(res.actionId, '::1')).status).toBe(200);
  });
});

describe('玩家可见日志', () => {
  it('按发生顺序返回，序号递增；支持 limit；非法 limit 返回 400', async () => {
    const s = await setup();
    await s.cultivate(1);
    s.time.t += 1000;
    await s.rest(2);
    const all = await s.log();
    expect(all.map((e) => e.type)).toEqual(['fixed', 'fixed']);
    expect(all[0]!.id).toBeLessThan(all[1]!.id);
    expect(all[1]!.at).toBe(T0 + 1000);
    expect(all[0]!.narrative).toContain('盘膝');
    const last = await s.log('?limit=1');
    expect(last).toHaveLength(1);
    expect(last[0]!.id).toBe(all[1]!.id);
    for (const q of ['?limit=0', '?limit=201', '?limit=abc', '?foo=1']) {
      expect((await s.app.inject({ method: 'GET', url: `/api/v1/log${q}` })).statusCode).toBe(400);
    }
  });

  it('突破日志带成功率、掷点、丹药名与境界变化', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realmProgress: 100 }, rng: 0 });
    await s.bt(1, PILL);
    const e = (await s.log())[0]!;
    expect(e.type).toBe('breakthrough');
    expect(e.breakthrough).toEqual({ outcome: 'success', chancePercent: 80, roll: 0, pillName: '凡阶突破丹', realmFrom: 'body_tempering', realmTo: 'opening' });
  });
});

describe('放置修炼的审计与日志', () => {
  it('开始与停止写审计事件（不带日志）；有收益的结算写日志', async () => {
    const s = await setup();
    const start = await s.cult('start');
    expect(start.log).toBeNull();
    s.time.t += 10 * MIN;
    const settled = await s.cult('settle');
    expect(settled.log).toMatchObject({ type: 'idle', changes: [{ stat: 'realmProgress', delta: 2 }], idle: { ticks: 10, offline: null } });
    s.time.t += 10 * MIN;
    const stop = await s.cult('stop');
    expect(stop.log?.type).toBe('idle');
    expect(await s.log()).toHaveLength(2);
  });

  it('没有收益的空结算不写事件、不写日志（避免每 30 秒产生噪声）', async () => {
    const s = await setup();
    await s.cult('start');
    const before = await s.log();
    for (let i = 0; i < 5; i++) {
      s.time.t += 10_000;
      const r = await s.cult('settle');
      expect(r.log).toBeNull();
    }
    expect(await s.log()).toEqual(before);
  });

  it('离线结算的日志带离线说明；没有收益时也留下一条', async () => {
    const s = await setup({ offline: {} });
    await s.cult('start');
    s.time.t += 6 * MIN; // 刚过阈值：6 × 0.105 不足 1 点
    const r = await s.cult('settle');
    expect(r.log).toMatchObject({ type: 'idle', changes: [], idle: { offline: { gapMs: 6 * MIN, efficiencyPercent: 50 } } });
    expect(r.log!.narrative).toContain('离开');
  });

  it('圆满：日志带提示，类型与审计正确', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realmProgress: 99 } });
    await s.cult('start');
    s.time.t += 24 * H;
    const r = await s.cult('settle');
    expect(r.log?.note).toContain('突破');
    expect(r.job).toBeNull();
  });
});

describe('持久化（文件数据库）：幂等与日志跨重启', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-audit-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const open = (file: string, initial?: PlayerState) => {
    const d = openDatabase(file);
    runMigrations(d.db);
    return { d, store: createSqliteGameStore(d.db, initial) };
  };
  const count = (d: Database_, table: string) => (d.sqlite.prepare(`select count(*) c from ${table}`).get() as { c: number }).c;

  it('重启后同一幂等键重试：返回同一结果，不重复结算、不重复扣丹药、不重复审计', async () => {
    const file = join(dir, 'a.sqlite');
    const a = open(file, { ...createInitialPlayer(), realmProgress: 100 });
    const s1 = await setup({ store: a.store, rng: 0 });
    const first = parse(await s1.bt(1, PILL));
    expect(first.breakthrough?.outcome).toBe('success');
    await s1.app.close();
    a.d.close();

    const b = open(file);
    const s2 = await setup({ store: b.store, rng: 0 });
    const replay = parse(await s2.bt(1, PILL));
    expect(replay).toEqual(first);
    expect(s2.store.read((tx) => tx.inventory().find((i) => i.itemId === PILL)?.quantity ?? 0)).toBe(0);
    expect(s2.store.read((tx) => tx.player().version)).toBe(1);
    expect(count(b.d, 'actions')).toBe(1);
    expect(count(b.d, 'audit_events')).toBe(2); // 突破事件 + 在场 NPC 的记忆后果事件（npc.memory）
    // 参数不同仍被拒绝
    expect((await s2.bt(1, null)).statusCode).toBe(409);
    // 日志也在
    expect(await s2.log()).toHaveLength(1);
    b.d.close();
  });

  it('日志与审计事件跨多次重启保留，序号继续递增不重复', async () => {
    const file = join(dir, 'b.sqlite');
    let lastId = 0;
    for (let round = 1; round <= 3; round++) {
      const x = open(file);
      const s = await setup({ store: x.store });
      s.time.t += round * 1000;
      const r = parse(await s.rest(round));
      expect(r.log!.id).toBeGreaterThan(lastId);
      lastId = r.log!.id;
      expect(await s.log()).toHaveLength(round);
      await s.app.close();
      x.d.close();
    }
  });

  it('事务失败整体回滚：行动、审计、日志、丹药、角色都不留痕（SQLite）', () => {
    const { d, store } = open(join(dir, 'c.sqlite'));
    const base = {
      id: 'act-1',
      kind: 'fixed' as const,
      idempotencyKey: key(1),
      fingerprint: 'fixed:rest',
      status: 'COMPLETED' as const,
      createdAt: T0,
    };
    expect(() =>
      store.transact((tx) => {
        const player = tx.player();
        tx.takeItem(PILL, 1);
        tx.savePlayer(player);
        tx.saveAction({ ...base, response: { actionId: 'act-1', status: 'COMPLETED', narrative: 'x', changes: [], breakthrough: null, log: null, ai: null, player } });
        tx.appendEvent({ actionId: 'act-1', eventType: 'x', before: { a: 1 }, after: { a: 2 }, at: T0, log: { type: 'system', narrative: 'n', changes: [], breakthrough: null, idle: null, note: null } });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count(d, 'actions')).toBe(0);
    expect(count(d, 'audit_events')).toBe(0);
    expect(store.read((tx) => tx.inventory().find((i) => i.itemId === PILL)?.quantity)).toBe(1);
    expect(store.read((tx) => tx.player().version)).toBe(0);
    d.close();
  });
});

describe('旧存档兼容：旧版本写入的行动响应（没有 ai 字段）', () => {
  it('SQLite：从库里读出时补默认值，同键重试照常回放', async () => {
    const d = openDatabase(':memory:');
    runMigrations(d.db);
    const store = createSqliteGameStore(d.db);
    const s = await setup({ store });
    const first = parse(await s.cultivate(1));
    // 模拟 T-010 时期的存档：响应 JSON 里没有 ai 字段
    const row = d.sqlite.prepare('select id, response_json from actions').get() as { id: string; response_json: string };
    const legacy = JSON.parse(row.response_json);
    delete legacy.ai;
    d.sqlite.prepare('update actions set response_json = ? where id = ?').run(JSON.stringify(legacy), row.id);
    const replay = parse(await s.cultivate(1));
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.ai).toBeNull();
    d.close();
  });
});
