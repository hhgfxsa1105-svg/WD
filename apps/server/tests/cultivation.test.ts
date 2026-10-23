import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CultivationResponseSchema, ErrorResponseSchema, type CultivationResponse, type PlayerState } from '@jhz/contracts';
import { IDLE_CULTIVATION, createInitialPlayer, createSeededRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';

const T0 = 1_800_000_000_000;
const MIN = IDLE_CULTIVATION.tickMs;

async function setup(opts: { player?: PlayerState; store?: GameStore; maxElapsedMs?: number } = {}) {
  const store = opts.store ?? createMemoryGameStore(opts.player);
  const time = { t: T0 };
  const app = await buildApp({ store, clock: { now: () => time.t }, maxElapsedMs: opts.maxElapsedMs });
  const call = async (method: 'GET' | 'POST', path: string) => {
    const res = await app.inject({ method, url: `/api/v1/cultivation${path}` });
    return { status: res.statusCode, body: res.json() as unknown };
  };
  const ok = async (method: 'GET' | 'POST', path: string): Promise<CultivationResponse> => {
    const r = await call(method, path);
    expect(r.status).toBe(200);
    return CultivationResponseSchema.parse(r.body);
  };
  return {
    app,
    store,
    time,
    call,
    get: () => ok('GET', ''),
    start: () => ok('POST', '/start'),
    settle: () => ok('POST', '/settle'),
    stop: () => ok('POST', '/stop'),
    player: () => store.read((tx) => tx.player()),
  };
}

describe('放置修炼', () => {
  it('开始：记录服务端开始时间；重复开始保持不变（幂等）', async () => {
    const s = await setup();
    const a = await s.start();
    expect(a.job).toMatchObject({ status: 'running', startedAt: T0, lastSettledAt: T0 });
    s.time.t += 5 * MIN;
    const b = await s.start();
    expect(b.job).toEqual(a.job);
  });

  it('结算：按服务端时间差计算收益，重复结算不重复领取', async () => {
    const s = await setup();
    await s.start();
    s.time.t += 10 * MIN;
    const first = await s.settle();
    expect(first.player.realmProgress).toBe(2);
    expect(first.changes).toEqual([{ stat: 'realmProgress', delta: 2 }]);
    expect(first.ticks).toBe(10);
    const again = await s.settle(); // 同一时刻再结算
    expect(again.changes).toEqual([]);
    expect(again.player.realmProgress).toBe(2);
    expect(again.player.version).toBe(first.player.version);
  });

  it('查询不会结算，也不改变版本', async () => {
    const s = await setup();
    await s.start();
    s.time.t += 60 * MIN;
    const v = s.player().version;
    const g = await s.get();
    expect(g.changes).toEqual([]);
    expect(s.player().version).toBe(v);
    expect(s.player().realmProgress).toBe(0);
  });

  it('客户端无法影响收益：接口不接受任何时间参数', async () => {
    const s = await setup();
    await s.start();
    s.time.t += 10 * MIN;
    const res = await s.app.inject({ method: 'POST', url: '/api/v1/cultivation/settle', payload: { now: T0 + 999 * MIN } });
    expect(res.statusCode).toBe(200);
    expect(CultivationResponseSchema.parse(res.json()).player.realmProgress).toBe(2);
  });

  it('频繁结算与一次结算的总收益相同（零头保留，不吃亏也不多拿）', async () => {
    const once = await setup();
    await once.start();
    once.time.t += 600 * MIN;
    const total = (await once.settle()).player.realmProgress;

    const polled = await setup();
    await polled.start();
    for (let i = 0; i < 600; i++) {
      polled.time.t += MIN;
      await polled.settle();
    }
    expect(polled.player().realmProgress).toBe(total);
  });

  it('随机时间点反复结算：总收益从不超过一次性结算', async () => {
    const rng = createSeededRng(77);
    const s = await setup();
    await s.start();
    let elapsed = 0;
    for (let i = 0; i < 80; i++) {
      const step = Math.floor(rng() * 20 * MIN);
      elapsed += step;
      s.time.t += step;
      await s.settle();
    }
    const ref = await setup();
    await ref.start();
    ref.time.t += elapsed;
    expect(s.player().realmProgress).toBeLessThanOrEqual((await ref.settle()).player.realmProgress);
  });

  it('时钟回拨：不报错、不产生收益、不倒退结算点', async () => {
    const s = await setup();
    await s.start();
    s.time.t -= 3600_000;
    const r = await s.settle();
    expect(r.changes).toEqual([]);
    expect(r.job!.lastSettledAt).toBe(T0);
  });

  it('离线上限：超出的时间作废，且不会在下次再次计入', async () => {
    const s = await setup({ maxElapsedMs: 100 * MIN });
    await s.start();
    s.time.t += 48 * 60 * MIN;
    const a = await s.settle();
    expect(a.ticks).toBeLessThanOrEqual(100);
    expect(a.player.realmProgress).toBeLessThanOrEqual(21);
    const b = await s.settle();
    expect(b.changes).toEqual([]);
  });

  it('进度圆满：自动结算到 100 并停止，提示可以突破', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realmProgress: 99 } });
    await s.start();
    s.time.t += 24 * 60 * MIN;
    const r = await s.settle();
    expect(r.player.realmProgress).toBe(100);
    expect(r.job).toBeNull();
    expect(r.notice).toContain('突破');
    expect((await s.settle()).changes).toEqual([]);
  });

  it('进度已满时不能开始', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realmProgress: 100 } });
    const r = await s.call('POST', '/start');
    expect(r.status).toBe(422);
    expect(ErrorResponseSchema.parse(r.body).code).toBe('PRECONDITION_FAILED');
  });

  it('停止：先结算再停止；重复停止不变；之后可以再次开始', async () => {
    const s = await setup();
    await s.start();
    s.time.t += 10 * MIN;
    const stopped = await s.stop();
    expect(stopped.job).toBeNull();
    expect(stopped.player.realmProgress).toBe(2);
    const v = stopped.player.version;
    s.time.t += 60 * MIN;
    expect((await s.stop()).player.version).toBe(v); // 已停止，不再有收益
    expect((await s.settle()).changes).toEqual([]);
    expect((await s.start()).job).toMatchObject({ status: 'running', startedAt: s.time.t });
  });

  it('后天及以上同时获得内力', async () => {
    const s = await setup({ player: { ...createInitialPlayer(), realm: 'houtian', neili: { current: 0, max: 60 } } });
    await s.start();
    s.time.t += 60 * MIN;
    const r = await s.settle();
    expect(r.changes.map((c) => c.stat)).toEqual(['realmProgress', 'neili']);
    expect(r.player.neili!.current).toBeGreaterThan(0);
  });
});

describe('持久化：重启后修炼继续、不重复领取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-cult-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('开始 → 重启 → 结算使用持久化的结算点', async () => {
    const file = join(dir, 'c.sqlite');
    const open = () => {
      const d = openDatabase(file);
      runMigrations(d.db);
      return { d, store: createSqliteGameStore(d.db) };
    };

    const a = open();
    const s1 = await setup({ store: a.store });
    await s1.start();
    await s1.app.close();
    a.d.close();

    const b = open();
    const s2 = await setup({ store: b.store });
    s2.time.t = T0 + 10 * MIN; // 重启后服务端时间已向前
    const first = await s2.settle();
    expect(first.player.realmProgress).toBe(2);
    expect((await s2.settle()).changes).toEqual([]);
    b.d.close();

    const c = open(); // 再次重启：已领取的不会重复发放
    const s3 = await setup({ store: c.store });
    s3.time.t = T0 + 10 * MIN;
    expect((await s3.settle()).changes).toEqual([]);
    expect(s3.player().realmProgress).toBe(2);
    c.d.close();
  });
});
