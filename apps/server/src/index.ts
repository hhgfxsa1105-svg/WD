import { buildApp } from './app.js';
import { loadDotEnv, loadEnv } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createSqliteGameStore } from './modules/store/sqlite.js';
import { WorldClock } from './shared/world-clock.js';

loadDotEnv();
const env = loadEnv();

const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const store = createSqliteGameStore(database.db);

const clock = new WorldClock(store.worldClock, {
  onRegression: (behindMs) => console.warn(`检测到系统时间早于游戏时间 ${Math.round(behindMs / 1000)} 秒，游戏时间暂停，待系统时间追平后继续`),
});
const app = await buildApp({ store, clock, clockBehindMs: () => clock.behindMs() });
await app.listen({ host: env.HOST, port: env.PORT });
console.log(`江湖志已启动：http://${env.HOST}:${env.PORT}（存档：${env.DB_PATH}）`);

const flushTimer = setInterval(() => clock.flush(false), 30_000);
flushTimer.unref();

const shutdown = async () => {
  clearInterval(flushTimer);
  clock.flush();
  await app.close();
  database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
