import { writeFileSync } from 'node:fs';
import { loadDotEnv, loadEnv } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { buildSaveFile } from '../modules/player/save-file.js';
import { createSqlitePlayerStore } from '../modules/player/sqlite-store.js';

loadDotEnv();
const env = loadEnv();
const out = process.argv[2];
const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const save = buildSaveFile(createSqlitePlayerStore(database.db).get());
database.close();
const text = JSON.stringify(save, null, 2) + '\n';
if (out) {
  writeFileSync(out, text);
  console.log(`已导出存档：${out}`);
} else {
  process.stdout.write(text);
}
