import { loadDotEnv, loadEnv } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { ensureSeed } from '../modules/store/sqlite.js';

loadDotEnv();
const env = loadEnv();
const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
ensureSeed(database.db);
database.close();
console.log(`迁移完成：${env.DB_PATH}`);
