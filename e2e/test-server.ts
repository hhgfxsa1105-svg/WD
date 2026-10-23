/**
 * 端到端测试专用服务入口：与生产相同的应用与 SQLite 存档，
 * 额外提供可控的时钟、随机源与状态注入接口（仅本文件注册，生产代码不含任何测试后门）。
 */
import { PlayerStateSchema } from '@jhz/contracts';
import { buildApp } from '../apps/server/src/app.js';
import { loadEnv } from '../apps/server/src/config/env.js';
import { openDatabase } from '../apps/server/src/db/connection.js';
import { runMigrations } from '../apps/server/src/db/migrate.js';
import { createSqliteGameStore } from '../apps/server/src/modules/store/sqlite.js';

const env = loadEnv();
const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const store = createSqliteGameStore(database.db);

const control = { offsetMs: 0, rng: 0.5 };
const app = await buildApp({ store, clock: { now: () => Date.now() + control.offsetMs }, rng: () => control.rng });

app.post('/__test/advance', async (req) => {
  control.offsetMs += Number((req.body as { ms: number }).ms);
  return { offsetMs: control.offsetMs };
});
app.post('/__test/rng', async (req) => {
  control.rng = Number((req.body as { value: number }).value);
  return { rng: control.rng };
});
app.post('/__test/player', async (req) => {
  const patch = req.body as Record<string, unknown>;
  const next = store.transact((tx) => tx.savePlayer(PlayerStateSchema.parse({ ...tx.player(), ...patch })));
  return { version: next.version };
});
app.post('/__test/item', async (req) => {
  const { itemId, quantity } = req.body as { itemId: string; quantity: number };
  store.transact((tx) => tx.addItem(itemId, quantity));
  return { ok: true };
});

await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  await app.close();
  database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
