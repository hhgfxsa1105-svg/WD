import { writeFileSync } from 'node:fs';
import { loadDotEnv, loadEnv } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { buildSaveFile } from '../modules/player/save-file.js';
import { createSqliteGameStore } from '../modules/store/sqlite.js';
import { snapshotWorld } from '../modules/store/world-rules.js';

loadDotEnv();
const env = loadEnv();
const out = process.argv[2];
const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const save = buildSaveFile(
  ...createSqliteGameStore(database.db).read((tx) => [tx.player(), snapshotWorld(tx)] as const),
);
database.close();
const text = JSON.stringify(save, null, 2) + '\n';
if (out) {
  writeFileSync(out, text);
  console.log(`已导出存档：${out}`);
} else {
  process.stdout.write(text);
}
