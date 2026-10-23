import type { InventoryItem, PlayerState } from '@jhz/contracts';

export interface CultivationJobRecord {
  id: string;
  methodId: string;
  status: 'running' | 'stopped';
  /** 服务端时间，毫秒时间戳 */
  startedAt: number;
  lastSettledAt: number;
}

/** 事务内可见的游戏状态读写。同一事务内的所有修改要么全部提交，要么全部回滚。 */
export interface GameTx {
  player(): PlayerState;
  /** 保存角色；next.version 必须等于事务内读到的版本（防止使用过期对象），成功后版本加一 */
  savePlayer(next: PlayerState): PlayerState;
  inventory(): InventoryItem[];
  /** 扣除物品；数量不足抛出 PRECONDITION_FAILED */
  takeItem(itemId: string, quantity: number): void;
  addItem(itemId: string, quantity: number): void;
  runningJob(): CultivationJobRecord | null;
  /** 新建或更新（按 id） */
  saveJob(job: CultivationJobRecord): void;
}

/** 单玩家游戏存档。transact 内抛出任何异常都会回滚此前的全部修改。 */
export interface GameStore {
  read<T>(fn: (tx: GameTx) => T): T;
  transact<T>(fn: (tx: GameTx) => T): T;
}
