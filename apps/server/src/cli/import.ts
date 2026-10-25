import { readFileSync } from 'node:fs';
import { loadDotEnv, loadEnv } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { parseSaveFile } from '../modules/player/save-file.js';
import { importSave } from '../modules/player/import.js';
import { createSqliteGameStore } from '../modules/store/sqlite.js';

loadDotEnv();
const env = loadEnv();
const file = process.argv[2];
if (!file) {
  console.error('用法：npm run db:import -- <存档文件.json>');
  process.exit(1);
}

let save;
try {
  save = parseSaveFile(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`导入失败：${(e as Error).message}`);
  process.exit(1);
}

const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
createSqliteGameStore(database.db); // 确保存在可被覆盖的基线
if (env.DB_PATH !== ':memory:') {
  const backup = `${env.DB_PATH}.bak-${Date.now()}`;
  database.sqlite.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  console.log(`已备份当前存档：${backup}`);
}
try {
  importSave(database.db, save);
} catch (e) {
  database.close();
  console.error(`导入失败（存档未改动）：${(e as Error).message}`);
  process.exit(1);
}
database.close();
console.log(`已导入存档（版本 ${save.player.version}${save.world ? '' : '；旧格式存档不含人物状态，已重置为初始'}）`);
