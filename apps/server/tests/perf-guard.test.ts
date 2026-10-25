import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createSeededRng } from '@jhz/game-rules';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';

/**
 * 性能护栏：阈值约为基线（docs/perf-baseline.md）的 10 倍以上，
 * 只用来发现数量级的退化（例如无意中引入全表扫描或 N+1 查询），不是基准测试本身。
 */
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;

describe('性能护栏（宽松阈值）', () => {
  it('固定行动、读接口与存档增长在目标范围内', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhz-perf-'));
    try {
      const file = join(dir, 'p.sqlite');
      const d = openDatabase(file);
      runMigrations(d.db);
      const app = await buildApp({ store: createSqliteGameStore(d.db), clock: { now: () => 1_800_000_000_000 }, rng: createSeededRng(1) });

      const N = 300;
      const before = (d.sqlite.pragma('page_count', { simple: true }) as number) * (d.sqlite.pragma('page_size', { simple: true }) as number);
      const actions: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        const r = await app.inject({
          method: 'POST',
          url: '/api/v1/actions',
          payload: { kind: 'fixed', idempotencyKey: `perf-${String(i).padStart(8, '0')}`, actionId: i % 2 === 0 ? 'cultivate' : 'rest' },
        });
        actions.push(performance.now() - t);
        expect(r.statusCode).toBe(200);
      }
      d.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      const after = (d.sqlite.pragma('page_count', { simple: true }) as number) * (d.sqlite.pragma('page_size', { simple: true }) as number);

      const reads: number[] = [];
      for (const url of ['/api/v1/player/state', '/api/v1/log?limit=100', '/api/v1/player/inventory']) {
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
          reads.push(performance.now() - t);
        }
      }

      expect(p95(actions), '固定行动 p95 (ms)').toBeLessThan(100); // 基线约 7 ms；目标 ≤ 50 ms
      expect(p95(reads), '读接口 p95 (ms)').toBeLessThan(50); // 基线约 3 ms；目标 ≤ 20 ms
      expect((after - before) / N, '每个行动的存档增长 (字节)').toBeLessThan(8192); // 基线约 2.7 KB；目标 ≤ 5 KB
      await app.close();
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
