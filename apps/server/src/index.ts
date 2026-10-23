import { buildApp } from './app.js';
import { loadDotEnv, loadEnv } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createSqliteGameStore } from './modules/store/sqlite.js';

loadDotEnv();
const env = loadEnv();

const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const store = createSqliteGameStore(database.db);

const app = await buildApp({ store });
await app.listen({ host: env.HOST, port: env.PORT });
console.log(`江湖志已启动：http://${env.HOST}:${env.PORT}（存档：${env.DB_PATH}）`);

const shutdown = async () => {
  await app.close();
  database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
