/**
 * 性能基线：规则函数吞吐、接口延迟、存档增长、启动耗时。
 * 运行：npm run bench（默认使用临时文件数据库；可用 BENCH_ACTIONS 调整行动次数）
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInitialPlayer, createSeededRng, resolveBreakthrough, resolveFixedAction, settleIdleCultivation } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';

const N = Number(process.env.BENCH_ACTIONS ?? 1000);
const T0 = 1_800_000_000_000;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fmt = (n: number) => (n < 1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(1));
const row = (name: string, xs: number[]) =>
  `| ${name} | ${fmt(xs.reduce((a, b) => a + b, 0) / xs.length)} | ${fmt(pct(xs, 50))} | ${fmt(pct(xs, 95))} | ${fmt(pct(xs, 99))} | ${fmt(Math.max(...xs))} |`;

async function timed(n: number, fn: (i: number) => Promise<unknown> | unknown): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    out.push(performance.now() - t);
  }
  return out;
}

// ---- 1. 规则函数吞吐（纯计算） ----
function rulesThroughput() {
  const iters = 200_000;
  const base = createInitialPlayer();
  const full = { ...base, realmProgress: 100 };
  const rng = createSeededRng(1);
  const bench = (name: string, fn: () => unknown) => {
    for (let i = 0; i < 5000; i++) fn(); // 预热
    const t = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const ms = performance.now() - t;
    return `| ${name} | ${fmt((ms / iters) * 1000)} | ${Math.round(iters / (ms / 1000)).toLocaleString('en-US')} |`;
  };
  return [
    '| 函数 | 单次耗时（µs） | 每秒次数 |',
    '|---|---|---|',
    bench('resolveFixedAction（修炼）', () => resolveFixedAction(base, 'cultivate')),
    bench('resolveBreakthrough', () => resolveBreakthrough(full, { now: T0, rng })),
    bench('settleIdleCultivation（600 片）', () => settleIdleCultivation(base, 'basic_breathing', 600)),
  ].join('\n');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-bench-'));
  const file = join(dir, 'bench.sqlite');
  try {
    // ---- 2. 启动：空库迁移 ----
    let t = performance.now();
    const d = openDatabase(file);
    runMigrations(d.db);
    const store = createSqliteGameStore(d.db);
    const coldStartMs = performance.now() - t;

    const clock = { t: T0 };
    const app = await buildApp({ store, clock: { now: () => clock.t }, rng: createSeededRng(7), offline: { thresholdMs: Number.MAX_SAFE_INTEGER } });
    const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, payload });
    const get = (url: string) => app.inject({ method: 'GET', url });

    // ---- 3. 接口延迟：固定行动（修炼/休息交替，每次唯一幂等键） ----
    const sizeBefore = statSync(file).size;
    const action = await timed(N, (i) =>
      post('/api/v1/actions', { kind: 'fixed', idempotencyKey: `bench-${String(i).padStart(8, '0')}`, actionId: i % 2 === 0 ? 'cultivate' : 'rest' }),
    );
    // WAL 模式下主文件增长滞后，强制检查点后再量
    d.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const sizeAfter = statSync(file).size;

    // 幂等回放（命中已有记录）
    const replay = await timed(500, (i) =>
      post('/api/v1/actions', { kind: 'fixed', idempotencyKey: `bench-${String(i * 2).padStart(8, '0')}`, actionId: 'cultivate' }),
    );
    // 突破（进度未满，被拒绝；测校验路径）
    const rejected = await timed(300, (i) =>
      post('/api/v1/actions', { kind: 'breakthrough', idempotencyKey: `bt-${String(i).padStart(8, '0')}`, pillItemId: null }),
    );
    // 读接口
    const state = await timed(500, () => get('/api/v1/player/state'));
    const log100 = await timed(300, () => get('/api/v1/log?limit=100'));
    const inv = await timed(300, () => get('/api/v1/player/inventory'));
    // 放置修炼结算
    await post('/api/v1/cultivation/start');
    const settle = await timed(300, () => {
      clock.t += 45_000;
      return post('/api/v1/cultivation/settle');
    });

    // ---- 4. 并发：同一进程内并发提交（事件循环串行处理，SQLite 同步事务） ----
    const par = 50;
    t = performance.now();
    await Promise.all(Array.from({ length: par }, (_, i) => post('/api/v1/actions', { kind: 'fixed', idempotencyKey: `par-${String(i).padStart(8, '0')}`, actionId: 'rest' })));
    const parMs = performance.now() - t;

    const events = (d.sqlite.prepare('select count(*) c from audit_events').get() as { c: number }).c;
    const actionsCount = (d.sqlite.prepare('select count(*) c from actions').get() as { c: number }).c;
    await app.close();
    d.close();

    // ---- 5. 启动：已有大量数据时的重新打开 ----
    t = performance.now();
    const d2 = openDatabase(file);
    runMigrations(d2.db);
    createSqliteGameStore(d2.db).read((tx) => tx.player());
    const warmStartMs = performance.now() - t;
    d2.close();

    const perAction = (sizeAfter - sizeBefore) / N;
    const lines = [
      `# 性能基线（${new Date().toISOString().slice(0, 10)}）`,
      '',
      `环境：Node ${process.version}，${cpus()[0]?.model.trim()} × ${cpus().length}，${process.platform}；文件数据库（WAL）；行动 ${N} 次。`,
      '',
      '## 规则函数（纯计算，无 IO）',
      rulesThroughput(),
      '',
      '## 接口延迟（Fastify inject，含校验、事务、审计与日志写入；单位 ms）',
      '| 接口 | 平均 | p50 | p95 | p99 | 最大 |',
      '|---|---|---|---|---|---|',
      row(`POST /actions 固定行动（${N} 次）`, action),
      row('POST /actions 幂等回放', replay),
      row('POST /actions 突破（被拒绝）', rejected),
      row('POST /cultivation/settle', settle),
      row('GET /player/state', state),
      row(`GET /log?limit=100（库内 ${events} 条审计）`, log100),
      row('GET /player/inventory', inv),
      '',
      `并发：同进程 ${par} 个并发行动提交共耗时 ${fmt(parMs)} ms（约 ${Math.round(par / (parMs / 1000))} 次/秒）。`,
      '',
      '## 存档',
      `- ${actionsCount} 个行动、${events} 条审计事件后，数据库文件 ${(sizeAfter / 1024).toFixed(0)} KB；每个行动平均增长约 ${perAction.toFixed(0)} 字节（含行动记录、审计事件与日志）。`,
      `- 启动（打开 + 迁移 + 读取）：空库 ${fmt(coldStartMs)} ms；含 ${events} 条审计的存档 ${fmt(warmStartMs)} ms。`,
    ];
    console.log(lines.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
