import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { MIGRATIONS_DIR, type Db } from './connection.js';

/**
 * 将数据库迁移到最新版本；可重复执行。
 *
 * 部分迁移需要「重建表」（SQLite 无法修改 CHECK 约束）。重建会 DROP 旧表，若外键开启，
 * 引用它的表会触发 ON DELETE 动作（例如把审计事件的 action_id 置空）。
 * `PRAGMA foreign_keys` 在事务内无效，所以按 SQLite 官方流程在迁移事务**之外**先关闭外键，
 * 迁移后恢复，并用 foreign_key_check 确认没有留下悬空引用；有则回报失败。
 */
export function runMigrations(db: Db): void {
  const sqlite = db.$client;
  const wasOn = sqlite.pragma('foreign_keys', { simple: true }) === 1;
  sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    const bad = sqlite.pragma('foreign_key_check') as { table: string; rowid: number; parent: string }[];
    if (bad.length > 0) throw new Error(`迁移后发现 ${bad.length} 处悬空的外键引用（例如 ${bad[0]!.table} → ${bad[0]!.parent}）`);
  } finally {
    if (wasOn) sqlite.pragma('foreign_keys = ON');
  }
}
