import type { ActionResponse, ActionStatus, AuditEvent, InventoryItem, LocationState, LogRecord, NewsItem, WorldEventRecord, NpcMemory, NpcState, PlayerState, QuestState, QuestStatus, Relationship } from '@jhz/contracts';
import type { LocationStatus, MemoryEventKind, NpcStatus, RelationDelta, RelationTargetType } from '@jhz/game-rules';

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
  kind: 'fixed' | 'breakthrough' | 'move' | 'quest';
  idempotencyKey: string;
  /** 行动参数的指纹，用于识别「同一幂等键、不同参数」 */
  fingerprint: string;
  status: ActionStatus;
  response: ActionResponse;
  createdAt: number;
}

/** 玩家可见日志的内容（序号与时间由存档层在写入时赋予） */
export type LogPayload = Omit<LogRecord, 'id' | 'at' | 'gameMinutes'>;

/** 一次改变了某条关系的审计事件（前后值来自事件的差异；before 为 null 表示此前没有这条关系） */
export interface RelationChangeRecord {
  seq: number;
  eventId: string;
  eventType: string;
  at: number;
  /** 造成变化的事件类型：npc.memory 是后果事件，真正的原因是紧挨着它之前的那个事件 */
  causeType: string;
  before: { affinity: number; trust: number; hostility: number } | null;
  after: { affinity: number; trust: number; hostility: number };
}

export interface AuditEventInput {
  /** 指定事件 ID（记忆需要在事件落库前拿到它）；不给则自动生成 */
  id?: string;
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

  /** 当前游戏时间（游戏分钟）。审计事件与玩家日志自动记录写入时刻的游戏时间 */
  gameMinutes(): number;
  /** 推进游戏时钟 minutes 个游戏分钟（整数，0..MAX_ADVANCE_MINUTES）；返回新时间。时间只增不减，非法参数 VALIDATION_FAILED */
  advanceGameClock(minutes: number): number;

  /** 全部 NPC 的可变状态（显示文字来自静态定义） */
  npcs(): NpcState[];
  /** 全部关系；方向为 npcId → (targetType, targetId) */
  relationships(): Relationship[];
  /** 按规则改变关系：单次每项限幅 ±20 并夹回合法范围；NPC 或对象不存在抛 NOT_FOUND；返回新值 */
  adjustRelationship(npcId: string, target: { type: RelationTargetType; id: string }, delta: RelationDelta): Relationship;
  /** 移动 NPC；NPC 或地点不存在抛 NOT_FOUND */
  moveNpc(npcId: string, locationId: string): NpcState;
  setNpcStatus(npcId: string, status: NpcStatus): NpcState;

  /** 全部地点的可变状态（名字、地区、描述来自静态定义） */
  locations(): LocationState[];
  /** 设置地点状态：封锁必须有原因（≤60 字），开放不能有；地点不存在 NOT_FOUND，不合法 VALIDATION_FAILED */
  setLocationStatus(id: string, status: LocationStatus, reason: string | null): LocationState;
  /** 标记玩家去过这个地点（幂等）；地点不存在 NOT_FOUND */
  visitLocation(id: string): LocationState;

  /** 全部世界事件的可变状态（名字、时间表来自静态定义） */
  worldEvents(): WorldEventRecord[];
  /** 事件行不存在则按初始状态创建（正常情况下建库时已播种；注入自定义事件表的测试用） */
  ensureWorldEvent(id: string): WorldEventRecord;
  /** 更新事件：状态只能向前（scheduled → open → resolved | missed）；了结后不可再变；不合法 PRECONDITION_FAILED，事件不存在 NOT_FOUND */
  updateWorldEvent(id: string, patch: Partial<Omit<WorldEventRecord, 'id'>>): WorldEventRecord;
  /** 传闻/新闻，按产生顺序；limit 只取最近的若干条 */
  news(limit?: number): NewsItem[];
  /** 追加一条传闻或新闻：同一事件同一种类只能有一条（重复 CONFLICT）；事件不存在 NOT_FOUND */
  addNews(input: { eventId: string; kind: NewsItem['kind']; text: string; gameMinutes: number; participated: boolean }): NewsItem;

  /** 全部任务的可变状态（名字、步骤、奖励来自静态定义） */
  quests(): QuestState[];
  /** 更新任务：状态流转必须合法、步数只增不减且不超过总数，否则 PRECONDITION_FAILED；任务不存在 NOT_FOUND */
  updateQuest(id: string, patch: { status?: QuestStatus; stepIndex?: number }, at: number): QuestState;
  /** 标记奖励已领取：仅 completed 且未领取，否则 PRECONDITION_FAILED（重复领取在这里被拒绝） */
  markQuestClaimed(id: string, at: number): QuestState;

  /** 某个 NPC 的全部记忆，按时间正序 */
  memories(npcId: string): NpcMemory[];
  /** 每个 NPC 的记忆条数（审计快照用） */
  memoryCounts(): Record<string, number>;
  /**
   * 写入一条事件记忆：NPC 与事件必须存在（事件须已在本事务或此前落库），摘要与重要性受约束；
   * 写入后若超过上限，在同一事务里把旧的低重要性记忆合并为摘要。
   */
  addMemory(input: { npcId: string; eventId: string; type: MemoryEventKind; summary: string; importance: number; at: number }): NpcMemory;

  /** 改变过某条关系的全部审计事件（按序号正序），用于解释关系数值的来源 */
  relationHistory(npcId: string, target: { type: RelationTargetType; id: string }): RelationChangeRecord[];

  findActionByKey(idempotencyKey: string): StoredAction | null;
  getAction(id: string): StoredAction | null;
  /** 新建或更新（按 id）；同一玩家的幂等键必须唯一，重复写入新行动会抛错 */
  saveAction(action: StoredAction): void;
  /** 追加审计事件；带日志内容时同时产生一条玩家可见日志并返回 */
  appendEvent(input: AuditEventInput): LogRecord | null;
  /** 只替换某个行动对应日志记录里的叙事文字（其余字段、序号、时间不变）；该行动没有日志时返回 null */
  replaceLogNarrative(actionId: string, narrative: string): LogRecord | null;
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
  /** AI 调用记录与每日额度，独立于游戏事务 */
  aiLog: AiCallLogStore;
}

/** AI 调用记录（只含元数据；不存提示词、回复全文与密钥） */
export interface AiCallRecord {
  id: string;
  actionId: string | null;
  purpose: 'parse' | 'narrate';
  provider: string;
  model: string;
  day: string;
  status: 'pending' | 'ok' | 'error';
  errorKind: string | null;
  attempts: number;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  requestChars: number;
  responseChars: number | null;
  createdAt: number;
}

export interface AiCallLogStore {
  /** 预占一次额度并返回记录 ID；与「检查是否超限」在同一个同步步骤内完成，因此并发调用不会超出上限 */
  reserve(e: { actionId: string | null; purpose: 'parse' | 'narrate'; provider: string; model: string; day: string; requestChars: number; at: number }): string;
  finish(id: string, r: { status: 'ok' | 'error'; errorKind: string | null; attempts: number; latencyMs: number; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; responseChars: number | null }): void;
  /** 当日已使用（含 pending 与失败）的调用次数；可按用途统计 */
  usedOn(day: string, purpose?: 'parse' | 'narrate'): number;
  recent(limit: number): AiCallRecord[];
}

export interface ClockPersistence {
  load(): number | null;
  save(highWaterAt: number): void;
}
