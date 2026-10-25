import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/** 仓库根目录（相对路径配置均以此为基准，避免依赖启动时的 cwd） */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

export interface Database_ {
  sqlite: Database.Database;
  db: ReturnType<typeof createDrizzle>;
  close(): void;
}
export type Db = Database_['db'];

const createDrizzle = (sqlite: Database.Database) => drizzle(sqlite, { schema });

/** 打开 SQLite 存档；path 可为 ':memory:'（测试用）。自动建目录并开启外键与 WAL。 */
export function openDatabase(path: string): Database_ {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  return { sqlite, db: createDrizzle(sqlite), close: () => sqlite.close() };
}
