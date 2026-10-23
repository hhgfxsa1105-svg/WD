import type { ActionResponse, ActionStatus, AuditEvent, InventoryItem, LogRecord, PlayerState } from '@jhz/contracts';

export interface CultivationJobRecord {
  id: string;
  methodId: string;
  status: 'running' | 'stopped';
  /** 服务端时间，毫秒时间戳 */
  startedAt: number;
  /** 已结算到的时间点；未消耗的零头时间保留在此点之后 */
  lastSettledAt: number;
  /** 上次接触（结算、开始、停止）时间，用于区分在线与离线 */
  lastCheckedAt: number;
}

/** 已落库的行动：幂等键唯一，重试时回放 response */
export interface StoredAction {
  id: string;
  kind: 'fixed' | 'breakthrough';
  idempotencyKey: string;
  /** 行动参数的指纹，用于识别「同一幂等键、不同参数」 */
  fingerprint: string;
  status: ActionStatus;
  response: ActionResponse;
  createdAt: number;
}

/** 玩家可见日志的内容（序号与时间由存档层在写入时赋予） */
export type LogPayload = Omit<LogRecord, 'id' | 'at'>;

export interface AuditEventInput {
  actionId: string | null;
  eventType: string;
  /** 只含发生变化的字段 */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: number;
  log: LogPayload | null;
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

  findActionByKey(idempotencyKey: string): StoredAction | null;
  getAction(id: string): StoredAction | null;
  /** 新建或更新（按 id）；同一玩家的幂等键必须唯一，重复写入新行动会抛错 */
  saveAction(action: StoredAction): void;
  /** 追加审计事件；带日志内容时同时产生一条玩家可见日志并返回 */
  appendEvent(input: AuditEventInput): LogRecord | null;
  /** 最近的玩家可见日志，按时间正序，最多 limit 条 */
  recentLog(limit: number): LogRecord[];
  eventsForAction(actionId: string): AuditEvent[];
}

/** 单玩家游戏存档。transact 内抛出任何异常都会回滚此前的全部修改。 */
export interface GameStore {
  read<T>(fn: (tx: GameTx) => T): T;
  transact<T>(fn: (tx: GameTx) => T): T;
  /** 世界时钟高水位的持久化（独立于游戏事务：时钟只增不减，写入失败不影响游戏结算） */
  worldClock: ClockPersistence;
}

export interface ClockPersistence {
  load(): number | null;
  save(highWaterAt: number): void;
}
