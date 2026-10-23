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
import type { OfflinePolicy } from '../src/modules/cultivation/service.js';
import type { GameStore } from '../src/modules/store/types.js';

const T0 = 1_800_000_000_000;
const MIN = IDLE_CULTIVATION.tickMs;

/** 默认视为始终在线（阈值无穷大），专注测试结算本身；离线策略见下方专门用例，那里使用真实默认策略 */
const ALWAYS_ONLINE: Partial<OfflinePolicy> = { thresholdMs: Number.MAX_SAFE_INTEGER };

async function setup(opts: { player?: PlayerState; store?: GameStore; offline?: Partial<OfflinePolicy> } = {}) {
  const store = opts.store ?? createMemoryGameStore(opts.player);
  const time = { t: T0 };
  const app = await buildApp({ store, clock: { now: () => time.t }, offline: opts.offline ?? ALWAYS_ONLINE });
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

describe('离线收益（真实默认策略：阈值 5 分钟、上限 12 小时、效率 50%）', () => {
  const REAL = {}; // 不覆盖，使用 OFFLINE 默认值
  const H = 60 * MIN;

  it('在线（间隔不超过阈值，如页面每 30 秒自动结算）：全额，且不带离线说明', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    let total = 0;
    for (let i = 0; i < 20; i++) {
      s.time.t += 30_000; // 每 30 秒一次，共 10 分钟
      const r = await s.settle();
      expect(r.offline).toBeNull();
      total += r.changes.find((c) => c.stat === 'realmProgress')?.delta ?? 0;
    }
    expect(total).toBe(2); // 10 分钟 × 0.21，全额
  });

  it('零头造成结算点滞后，也不会把在线结算误判为离线（按「上次接触」而非结算点判断）', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    for (let i = 0; i < 120; i++) {
      s.time.t += 30_000; // 1 小时，每 30 秒结算；结算点会因零头滞后数分钟
      expect((await s.settle()).offline).toBeNull();
    }
    expect(s.player().realmProgress).toBe(12); // 60 × 0.21 = 12.6 → 12
  });

  it('离线：按 50% 效率结算，并返回离线说明', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 2 * H;
    const r = await s.settle();
    expect(r.offline).toEqual({ gapMs: 2 * H, countedMs: 2 * H, capped: false, efficiencyPercent: 50 });
    expect(r.player.realmProgress).toBe(12); // 120 × 0.21 × 0.5 = 12.6 → 12
  });

  it('离线超过 12 小时只计入 12 小时，超出部分作废，且不会下次再计入', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 48 * H;
    const r = await s.settle();
    expect(r.offline).toMatchObject({ gapMs: 48 * H, countedMs: 12 * H, capped: true, efficiencyPercent: 50 });
    expect(r.player.realmProgress).toBe(75); // 720 × 0.21 × 0.5 = 75.6 → 75
    const again = await s.settle();
    expect(again.changes).toEqual([]);
    expect(again.player.realmProgress).toBe(75);
  });

  it('超长离线无法靠反复结算获得更多：总收益不超过一次封顶', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 1000 * H; // 约 41 天
    await s.settle();
    const afterFirst = s.player().realmProgress;
    for (let i = 0; i < 50; i++) await s.settle();
    expect(s.player().realmProgress).toBe(afterFirst);
    expect(afterFirst).toBe(75);
  });

  it('离线封顶造成的进度圆满：停止并提示', async () => {
    const s = await setup({ offline: REAL, player: { ...createInitialPlayer(), realmProgress: 50 } });
    await s.start();
    s.time.t += 48 * H;
    const r = await s.settle();
    expect(r.player.realmProgress).toBe(100);
    expect(r.job).toBeNull();
    expect(r.notice).toContain('突破');
  });

  it('离线结算后恢复在线：下一次 30 秒内结算按全额，不再带离线说明', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 2 * H;
    expect((await s.settle()).offline).not.toBeNull();
    s.time.t += 30_000;
    expect((await s.settle()).offline).toBeNull();
  });

  it('离线结算不保留零头：不会在下次在线结算时按全额重新计价', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 6 * MIN; // 刚过阈值的短离线：6 × 0.105 = 0.63，不足 1 点
    const a = await s.settle();
    expect(a.offline).not.toBeNull();
    expect(a.changes).toEqual([]);
    s.time.t += 30_000;
    const b = await s.settle(); // 之后的在线结算只计这 30 秒，不应把那 6 分钟按全额补回来
    expect(b.offline).toBeNull();
    expect(b.changes).toEqual([]);
    expect(s.player().realmProgress).toBe(0);
  });

  it('后天及以上：离线内力同比折算', async () => {
    const s = await setup({ offline: REAL, player: { ...createInitialPlayer(), realm: 'houtian', neili: { current: 0, max: 600 } } });
    await s.start();
    s.time.t += 2 * H;
    const r = await s.settle();
    // 产出 12 点进度所需最少 115 片；内力 = 115 × 0.5 × 0.5 = 28.75 → 28
    expect(r.changes).toContainEqual({ stat: 'neili', delta: 28 });
  });

  it('客户端无法影响离线判定：不接受任何时间或标志参数', async () => {
    const s = await setup({ offline: REAL });
    await s.start();
    s.time.t += 2 * H;
    const res = await s.app.inject({ method: 'POST', url: '/api/v1/cultivation/settle', payload: { offline: false, now: T0 + 999 * H, efficiency: 1 } });
    expect(res.statusCode).toBe(200);
    expect(CultivationResponseSchema.parse(res.json()).player.realmProgress).toBe(12);
  });

  it('重启跨越长时间：按离线结算且只领取一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhz-off-'));
    try {
      const file = join(dir, 'o.sqlite');
      const open = () => {
        const d = openDatabase(file);
        runMigrations(d.db);
        return { d, store: createSqliteGameStore(d.db) };
      };
      const a = open();
      const s1 = await setup({ store: a.store, offline: REAL });
      await s1.start();
      await s1.app.close();
      a.d.close();

      const b = open();
      const s2 = await setup({ store: b.store, offline: REAL });
      s2.time.t = T0 + 30 * H; // 服务停了 30 小时
      const first = await s2.settle();
      expect(first.offline).toMatchObject({ capped: true, countedMs: 12 * H });
      expect(first.player.realmProgress).toBe(75);
      expect((await s2.settle()).changes).toEqual([]);
      b.d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧存档（没有接触时间）按结算点处理，不报错', async () => {
    const d = openDatabase(':memory:');
    runMigrations(d.db);
    const store = createSqliteGameStore(d.db);
    d.sqlite
      .prepare("insert into cultivation_jobs (id, player_id, method_id, status, started_at, last_settled_at) values ('old','player_1','basic_breathing','running',?,?)")
      .run(T0, T0);
    const s = await setup({ store, offline: REAL });
    s.time.t += 10 * 60_000;
    const r = await s.settle(); // 距结算点 10 分钟 > 阈值 → 离线
    expect(r.offline).not.toBeNull();
    expect(r.player.realmProgress).toBe(1); // 10 × 0.21 × 0.5 = 1.05 → 1
  });
});
