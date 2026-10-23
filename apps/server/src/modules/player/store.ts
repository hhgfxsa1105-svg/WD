import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import { createInitialPlayer } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';

/** 单玩家存档接口。T-005 起由 SQLite 实现替换，调用方不变。 */
export interface PlayerStore {
  get(): PlayerState;
  /** 乐观并发：仅当当前版本等于 expectedVersion 才提交，并将版本加一 */
  commit(next: PlayerState, expectedVersion: number): PlayerState;
}

export function createMemoryPlayerStore(initial: PlayerState = createInitialPlayer()): PlayerStore {
  let current = PlayerStateSchema.parse(initial);
  return {
    get: () => structuredClone(current),
    commit(next, expectedVersion) {
      if (current.version !== expectedVersion) throw new AppError('CONFLICT', '角色状态已变化，请刷新后重试');
      current = PlayerStateSchema.parse({ ...next, version: expectedVersion + 1 });
      return structuredClone(current);
    },
  };
}
