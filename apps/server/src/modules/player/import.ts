import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/connection.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import { createSqliteGameStore, writePlayerState, writeWorldState } from '../store/sqlite.js';
import { mergeImportedWorld } from '../store/world-rules.js';
import type { parseSaveFile } from './save-file.js';

export type ParsedSave = ReturnType<typeof parseSaveFile>;

/**
 * 把存档文件写入数据库（整体在一个事务里，失败全部回滚；调用方负责事先备份）。
 * 审计：先写 `save.import` 标记事件（导入的记忆引用它），导入完成后再写 `save.state` 事件记录整体前后差异，
 * 因此导入也不会在审计历史里留下无法解释的状态跳变。导入的记忆原样保留，「已相识」等依赖记忆的判定不受影响。
 * 文件内容不合格时在写入前抛出带中文原因的 Error。
 */
export function importSave(db: Db, save: ParsedSave, now: number = Date.now()): { eventId: string } {
  const world = save.world ? mergeImportedWorld(save.world, now, save.player.location.id) : null; // 先校验，再动库
  const store = createSqliteGameStore(db);
  const eventId = randomUUID();
  db.transaction(() => {
    const before = store.read((tx) => snapshot(tx));
    store.transact((tx) => tx.appendEvent({ id: eventId, actionId: null, eventType: 'save.import', before: null, after: null, at: now, log: null }));
    writePlayerState(db, save.player);
    writeWorldState(db, world, eventId, save.player.location.id);
    const diff = stateDiff(before, store.read((tx) => snapshot(tx)));
    if (diff) store.transact((tx) => tx.appendEvent({ actionId: null, eventType: 'save.state', before: diff.before, after: diff.after, at: now, log: null }));
  });
  return { eventId };
}
