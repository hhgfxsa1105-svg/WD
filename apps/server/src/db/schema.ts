import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const nowMs = sql`(unixepoch('subsec') * 1000)`;
/** 与 @jhz/contracts 的 REALMS 保持一致（测试校验）；drizzle-kit 无法加载 TS 源码包，故此处内联 */
export const DB_REALMS = ['body_tempering', 'opening', 'houtian', 'xiantian', 'grandmaster', 'mingshen', 'land_immortal'] as const;
const realmList = sql.raw(DB_REALMS.map((r) => `'${r}'`).join(', '));

export const players = sqliteTable('players', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at').notNull().default(nowMs),
  updatedAt: integer('updated_at').notNull().default(nowMs),
});

/** 角色当前状态（权威存档）。名号与六维以 JSON 存储，数值型资源拆列以便约束。 */
export const playerStates = sqliteTable(
  'player_states',
  {
    playerId: text('player_id').primaryKey(),
    realm: text('realm').notNull(),
    realmProgress: integer('realm_progress').notNull(),
    hp: integer('hp').notNull(),
    maxHp: integer('max_hp').notNull(),
    stamina: integer('stamina').notNull(),
    maxStamina: integer('max_stamina').notNull(),
    neiliCurrent: integer('neili_current'),
    neiliMax: integer('neili_max'),
    yuanbao: integer('yuanbao').notNull(),
    silver: integer('silver').notNull(),
    copper: integer('copper').notNull(),
    attributesJson: text('attributes_json').notNull(),
    titleJson: text('title_json'),
    epithetJson: text('epithet_json'),
    fateJson: text('fate_json'),
    locationId: text('location_id').notNull(),
    locationName: text('location_name').notNull(),
    breakthroughAvailableAt: integer('breakthrough_available_at'),
    version: integer('version').notNull().default(0),
    createdAt: integer('created_at').notNull().default(nowMs),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.playerId], foreignColumns: [players.id] }).onDelete('cascade'),
    check('player_states_realm_valid', sql`${t.realm} in (${realmList})`),
    check('player_states_progress_range', sql`${t.realmProgress} between 0 and 100`),
    check('player_states_hp_range', sql`${t.hp} >= 0 and ${t.maxHp} >= 1 and ${t.hp} <= ${t.maxHp}`),
    check('player_states_stamina_range', sql`${t.stamina} >= 0 and ${t.maxStamina} >= 1 and ${t.stamina} <= ${t.maxStamina}`),
    check(
      'player_states_neili_consistent',
      sql`(${t.neiliCurrent} is null and ${t.neiliMax} is null) or (${t.neiliCurrent} is not null and ${t.neiliMax} is not null and ${t.neiliCurrent} >= 0 and ${t.neiliMax} >= 1 and ${t.neiliCurrent} <= ${t.neiliMax})`,
    ),
    check('player_states_currency_nonneg', sql`${t.yuanbao} >= 0 and ${t.silver} >= 0 and ${t.copper} >= 0`),
    check('player_states_version_nonneg', sql`${t.version} >= 0`),
    check('player_states_cooldown_nonneg', sql`${t.breakthroughAvailableAt} is null or ${t.breakthroughAvailableAt} >= 0`),
  ],
);

/** 背包：玩家持有的物品数量（物品定义在规则表中） */
export const inventory = sqliteTable(
  'inventory',
  {
    playerId: text('player_id').notNull(),
    itemId: text('item_id').notNull(),
    quantity: integer('quantity').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.itemId] }),
    foreignKey({ columns: [t.playerId], foreignColumns: [players.id] }).onDelete('cascade'),
    check('inventory_quantity_range', sql`${t.quantity} >= 0 and ${t.quantity} <= 9999`),
  ],
);

/** 放置修炼任务；同一玩家同一时间最多一个 running（唯一部分索引保证） */
export const cultivationJobs = sqliteTable(
  'cultivation_jobs',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id').notNull(),
    methodId: text('method_id').notNull(),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    lastSettledAt: integer('last_settled_at').notNull(),
    /** 上次接触（结算、开始、停止）时间，用于区分在线与离线；旧数据为 NULL，按 lastSettledAt 处理 */
    lastCheckedAt: integer('last_checked_at'),
    createdAt: integer('created_at').notNull().default(nowMs),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.playerId], foreignColumns: [players.id] }).onDelete('cascade'),
    check('cultivation_jobs_status_valid', sql`${t.status} in ('running', 'stopped')`),
    check('cultivation_jobs_time_order', sql`${t.startedAt} >= 0 and ${t.lastSettledAt} >= ${t.startedAt}`),
    uniqueIndex('cultivation_jobs_one_running').on(t.playerId).where(sql`${t.status} = 'running'`),
    index('cultivation_jobs_player_idx').on(t.playerId),
  ],
);

/** 世界时钟的单调高水位：服务端见过的最晚时间，防止系统时间被调到过去后重复计入时间 */
export const worldClock = sqliteTable(
  'world_clock',
  {
    id: text('id').primaryKey(),
    highWaterAt: integer('high_water_at').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [check('world_clock_nonneg', sql`${t.highWaterAt} >= 0`)],
);

/** 与 @jhz/contracts 的 ACTION_STATUSES / ACTION_KINDS 保持一致（测试校验） */
export const DB_ACTION_STATUSES = ['RECEIVED', 'PARSING', 'VALIDATING', 'RESOLVING', 'COMMITTED', 'NARRATED', 'COMPLETED', 'FAILED'] as const;
export const DB_ACTION_KINDS = ['fixed', 'breakthrough', 'move', 'quest'] as const;
const statusList = sql.raw(DB_ACTION_STATUSES.map((x) => `'${x}'`).join(', '));
const kindList = sql.raw(DB_ACTION_KINDS.map((x) => `'${x}'`).join(', '));

/** 行动记录：幂等键在同一玩家内唯一；重试时回放保存的首次结果 */
export const actions = sqliteTable(
  'actions',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    /** 行动参数的指纹，用于识别「同一幂等键、不同参数」 */
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.playerId], foreignColumns: [players.id] }).onDelete('cascade'),
    uniqueIndex('actions_player_key_unique').on(t.playerId, t.idempotencyKey),
    check('actions_status_valid', sql`${t.status} in (${statusList})`),
    check('actions_kind_valid', sql`${t.kind} in (${kindList})`),
    check('actions_response_json_valid', sql`json_valid(${t.responseJson})`),
    check('actions_key_length', sql`length(${t.idempotencyKey}) between 8 and 64`),
  ],
);

/** 审计事件：关键状态变更的前后差异，同时承载玩家可见日志（log_json）。seq 单调递增，用于排序。 */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    actorId: text('actor_id').notNull(),
    actionId: text('action_id'),
    eventType: text('event_type').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    logJson: text('log_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.actorId], foreignColumns: [players.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.actionId], foreignColumns: [actions.id] }).onDelete('set null'),
    uniqueIndex('audit_events_id_unique').on(t.id),
    index('audit_events_action_idx').on(t.actionId),
    check('audit_events_type_nonempty', sql`length(${t.eventType}) > 0`),
    check('audit_events_before_json_valid', sql`${t.beforeJson} is null or json_valid(${t.beforeJson})`),
    check('audit_events_after_json_valid', sql`${t.afterJson} is null or json_valid(${t.afterJson})`),
    check('audit_events_log_json_valid', sql`${t.logJson} is null or json_valid(${t.logJson})`),
  ],
);

/**
 * AI 调用记录：只存元数据（用途、模型、耗时、token 用量、状态、长度），
 * 不存提示词与模型回复全文，也不存密钥。每日调用上限按 day 统计，重启后依然有效。
 */
export const aiCallLogs = sqliteTable(
  'ai_call_logs',
  {
    id: text('id').primaryKey(),
    actionId: text('action_id'),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** 本地日期 YYYY-MM-DD，用于每日上限统计 */
    day: text('day').notNull(),
    /** pending 表示已预占额度、尚未结束（崩溃后保留，按保守口径计入上限） */
    status: text('status').notNull(),
    errorKind: text('error_kind'),
    attempts: integer('attempts').notNull().default(0),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    requestChars: integer('request_chars').notNull(),
    responseChars: integer('response_chars'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.actionId], foreignColumns: [actions.id] }).onDelete('set null'),
    index('ai_call_logs_day_idx').on(t.day),
    check('ai_call_logs_purpose_valid', sql`${t.purpose} in ('parse', 'narrate')`),
    check('ai_call_logs_status_valid', sql`${t.status} in ('pending', 'ok', 'error')`),
    check('ai_call_logs_day_format', sql`${t.day} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check('ai_call_logs_attempts_nonneg', sql`${t.attempts} >= 0`),
    check('ai_call_logs_nonneg', sql`${t.requestChars} >= 0 and (${t.responseChars} is null or ${t.responseChars} >= 0) and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`),
  ],
);

/** 与 @jhz/contracts / game-rules 保持一致（测试校验）；此处内联原因同 DB_REALMS */
export const DB_NPC_STATUSES = ['active', 'away', 'resting'] as const;
const npcStatusList = sql.raw(DB_NPC_STATUSES.map((r) => `'${r}'`).join(', '));

/** NPC 的可变状态（权威存档）。名字、身份、简介来自静态定义，不存数据库；地点 ID 由代码按定义校验 */
export const npcs = sqliteTable(
  'npcs',
  {
    id: text('id').primaryKey(),
    locationId: text('location_id').notNull(),
    status: text('status').notNull(),
    goalsJson: text('goals_json').notNull(),
    createdAt: integer('created_at').notNull().default(nowMs),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    check('npcs_id_format', sql`${t.id} glob 'npc_*' and length(${t.id}) <= 64`),
    check('npcs_location_format', sql`${t.locationId} glob 'loc_*' and length(${t.locationId}) <= 64`),
    check('npcs_status_valid', sql`${t.status} in (${npcStatusList})`),
    check('npcs_goals_json_valid', sql`json_valid(${t.goalsJson}) and json_type(${t.goalsJson}) = 'array'`),
    index('npcs_location_idx').on(t.locationId),
  ],
);

/** NPC 关系：方向固定为 npc_id → (target_type, target_id)；数值范围由 CHECK 约束 */
export const npcRelationships = sqliteTable(
  'npc_relationships',
  {
    npcId: text('npc_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    affinity: integer('affinity').notNull(),
    trust: integer('trust').notNull(),
    hostility: integer('hostility').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    primaryKey({ columns: [t.npcId, t.targetType, t.targetId] }),
    foreignKey({ columns: [t.npcId], foreignColumns: [npcs.id] }).onDelete('cascade'),
    check('npc_relationships_target_type', sql`${t.targetType} in ('player', 'npc')`),
    check('npc_relationships_no_self', sql`not (${t.targetType} = 'npc' and ${t.targetId} = ${t.npcId})`),
    check('npc_relationships_affinity_range', sql`${t.affinity} between -100 and 100`),
    check('npc_relationships_trust_range', sql`${t.trust} between 0 and 100`),
    check('npc_relationships_hostility_range', sql`${t.hostility} between 0 and 100`),
    index('npc_relationships_target_idx').on(t.targetType, t.targetId),
  ],
);

/** 与 @jhz/contracts 的 MEMORY_TYPES 保持一致（测试校验） */
export const DB_MEMORY_TYPES = ['met', 'breakthrough_success', 'breakthrough_failure', 'summary'] as const;
const memoryTypeList = sql.raw(DB_MEMORY_TYPES.map((r) => `'${r}'`).join(', '));

/**
 * NPC 记忆：结构化、可检索。事件记忆必须引用已记录的审计事件（外键 RESTRICT：被引用的审计事件不能被删除）；
 * 只有合并产生的 summary 没有单一事件。摘要由服务端模板生成，不接受 AI 文本。
 */
export const npcMemories = sqliteTable(
  'npc_memories',
  {
    id: text('id').primaryKey(),
    npcId: text('npc_id').notNull(),
    eventId: text('event_id'),
    memoryType: text('memory_type').notNull(),
    summary: text('summary').notNull(),
    importance: integer('importance').notNull(),
    sourceCount: integer('source_count').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.npcId], foreignColumns: [npcs.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.eventId], foreignColumns: [auditEvents.id] }).onDelete('restrict'),
    check('npc_memories_type_valid', sql`${t.memoryType} in (${memoryTypeList})`),
    check('npc_memories_event_rule', sql`(${t.memoryType} = 'summary') = (${t.eventId} is null)`),
    check('npc_memories_summary_len', sql`length(${t.summary}) between 1 and 160`),
    check('npc_memories_importance_range', sql`${t.importance} between 1 and 10`),
    check('npc_memories_source_count', sql`${t.sourceCount} between 1 and 10000`),
    check('npc_memories_created_at', sql`${t.createdAt} >= 0`),
    index('npc_memories_npc_idx').on(t.npcId, t.createdAt),
    index('npc_memories_event_idx').on(t.eventId),
  ],
);

/** 与 @jhz/contracts 的 QUEST_STATUSES 保持一致（测试校验） */
export const DB_QUEST_STATUSES = ['locked', 'available', 'active', 'completed', 'failed'] as const;
const questStatusList = sql.raw(DB_QUEST_STATUSES.map((r) => `'${r}'`).join(', '));

/**
 * 任务状态（权威存档）。任务名、步骤、奖励来自静态定义。
 * 约束：接取时间当且仅当状态已离开 locked/available；结束时间当且仅当 completed/failed；奖励只有 completed 才可能已领取。
 */
export const quests = sqliteTable(
  'quests',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    stepIndex: integer('step_index').notNull().default(0),
    acceptedAt: integer('accepted_at'),
    finishedAt: integer('finished_at'),
    claimedAt: integer('claimed_at'),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    check('quests_id_format', sql`${t.id} glob 'quest_*' and length(${t.id}) <= 64`),
    check('quests_status_valid', sql`${t.status} in (${questStatusList})`),
    check('quests_step_range', sql`${t.stepIndex} between 0 and 50`),
    check('quests_accepted_rule', sql`(${t.acceptedAt} is null) = (${t.status} in ('locked', 'available'))`),
    check('quests_finished_rule', sql`(${t.finishedAt} is null) = (${t.status} not in ('completed', 'failed'))`),
    check('quests_claimed_rule', sql`${t.claimedAt} is null or ${t.status} = 'completed'`),
  ],
);

/** 与 @jhz/contracts 的 LOCATION_STATUSES 保持一致（测试校验） */
export const DB_LOCATION_STATUSES = ['open', 'blocked'] as const;
const locationStatusList = sql.raw(DB_LOCATION_STATUSES.map((r) => `'${r}'`).join(', '));

/** 与 @jhz/contracts 的 WORLD_EVENT_STATES 保持一致（测试校验） */
export const DB_WORLD_EVENT_STATES = ['scheduled', 'open', 'resolved', 'missed'] as const;
const eventStateList = sql.raw(DB_WORLD_EVENT_STATES.map((r) => `'${r}'`).join(', '));

/**
 * 世界事件的可变状态：每个静态事件一行（id 即事件定义 ID）。
 * 约束：了结（resolved / missed）当且仅当有了结时间；参加过的事件必定是 resolved；布尔只能 0/1。
 */
export const worldEvents = sqliteTable(
  'world_events',
  {
    id: text('id').primaryKey(),
    state: text('state').notNull(),
    rumored: integer('rumored').notNull().default(0),
    participated: integer('participated').notNull().default(0),
    resolvedAt: integer('resolved_at'),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    check('world_events_id_format', sql`${t.id} glob 'evt_*' and length(${t.id}) <= 48`),
    check('world_events_state_valid', sql`${t.state} in (${eventStateList})`),
    check('world_events_flags', sql`${t.rumored} in (0, 1) and ${t.participated} in (0, 1)`),
    check('world_events_resolved_time', sql`(${t.state} in ('resolved', 'missed')) = (${t.resolvedAt} is not null)`),
    check('world_events_resolved_time_nonneg', sql`${t.resolvedAt} is null or ${t.resolvedAt} >= 0`),
    check('world_events_participated_resolved', sql`${t.participated} = 0 or ${t.state} = 'resolved'`),
  ],
);

/**
 * 传闻与新闻：每个事件的每种消息最多一条（唯一索引去重，重复调度写不进第二条）。
 * seq 递增，保证展示顺序稳定。
 */
export const news = sqliteTable(
  'news',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    eventId: text('event_id').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    gameMinutes: integer('game_minutes').notNull(),
    participated: integer('participated').notNull().default(0),
    createdAt: integer('created_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.eventId], foreignColumns: [worldEvents.id] }).onDelete('cascade'),
    uniqueIndex('news_id_unique').on(t.id),
    uniqueIndex('news_event_kind_unique').on(t.eventId, t.kind),
    check('news_kind_valid', sql`${t.kind} in ('rumor', 'news')`),
    check('news_text_len', sql`length(${t.text}) between 1 and 400`),
    check('news_time_nonneg', sql`${t.gameMinutes} >= 0`),
    check('news_participated_flag', sql`${t.participated} in (0, 1)`),
  ],
);

/**
 * 势力的可变状态：实力 0..100、对玩家的态度 −100..100。只能由程序定义的事件通过存档层小幅改动。
 */
export const factions = sqliteTable(
  'factions',
  {
    id: text('id').primaryKey(),
    strength: integer('strength').notNull(),
    attitude: integer('attitude').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    check('factions_id_format', sql`${t.id} glob 'fac_*' and length(${t.id}) <= 40`),
    check('factions_strength_range', sql`${t.strength} between 0 and 100`),
    check('factions_attitude_range', sql`${t.attitude} between -100 and 100`),
  ],
);

/** 势力之间的关系：a < b 保证一对势力只有一行（双向共用一个数值） */
export const factionRelations = sqliteTable(
  'faction_relations',
  {
    a: text('a').notNull(),
    b: text('b').notNull(),
    value: integer('value').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    primaryKey({ columns: [t.a, t.b] }),
    foreignKey({ columns: [t.a], foreignColumns: [factions.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.b], foreignColumns: [factions.id] }).onDelete('cascade'),
    check('faction_relations_order', sql`${t.a} < ${t.b}`),
    check('faction_relations_range', sql`${t.value} between -100 and 100`),
  ],
);

/** 势力历史：每个造成了势力变化的事件一条（事件唯一）；变化明细是前后值，可重放核对 */
export const factionHistory = sqliteTable(
  'faction_history',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    eventId: text('event_id').notNull(),
    gameMinutes: integer('game_minutes').notNull(),
    text: text('text').notNull(),
    changesJson: text('changes_json').notNull(),
    createdAt: integer('created_at').notNull().default(nowMs),
  },
  (t) => [
    foreignKey({ columns: [t.eventId], foreignColumns: [worldEvents.id] }).onDelete('cascade'),
    uniqueIndex('faction_history_id_unique').on(t.id),
    uniqueIndex('faction_history_event_unique').on(t.eventId),
    check('faction_history_text_len', sql`length(${t.text}) between 1 and 400`),
    check('faction_history_time_nonneg', sql`${t.gameMinutes} >= 0`),
    check('faction_history_changes_json', sql`json_valid(${t.changesJson}) and json_type(${t.changesJson}) = 'array'`),
  ],
);

/** 与 @jhz/contracts 的 PERSONAL_STATES 保持一致（测试校验） */
export const DB_PERSONAL_STATES = ['active', 'resolved', 'abandoned', 'expired'] as const;
const personalStateList = sql.raw(DB_PERSONAL_STATES.map((r) => `'${r}'`).join(', '));

/**
 * 个人事件（个人轨）：玩家自定义行为 → AI 提议 → 玩家进行或放弃。
 * 约束：同一时间最多一个 active（唯一部分索引 = 玩家「正忙」）；
 * 进行中没有结果，其余必须有；只有 resolved 有掷点；放弃 / 作废只能是失败；幂等键唯一。
 */
export const personalEvents = sqliteTable(
  'personal_events',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key'),
    fingerprint: text('fingerprint'),
    state: text('state').notNull(),
    intent: text('intent').notNull(),
    proposalJson: text('proposal_json').notNull(),
    createdAtMinutes: integer('created_at_minutes').notNull(),
    expiresAtMinutes: integer('expires_at_minutes').notNull(),
    chancePercent: integer('chance_percent').notNull(),
    outcome: text('outcome'),
    roll: real('roll'),
    resolvedAtMinutes: integer('resolved_at_minutes'),
    lockLocationId: text('lock_location_id'),
    lockReason: text('lock_reason'),
    lockUntilMinutes: integer('lock_until_minutes'),
    lockReleased: integer('lock_released').notNull().default(0),
    createdAt: integer('created_at').notNull().default(nowMs),
  },
  (t) => [
    uniqueIndex('personal_events_key_unique').on(t.idempotencyKey),
    uniqueIndex('personal_events_one_active').on(t.state).where(sql`${t.state} = 'active'`),
    check('personal_events_state_valid', sql`${t.state} in (${personalStateList})`),
    check('personal_events_outcome_valid', sql`${t.outcome} is null or ${t.outcome} in ('success', 'failure')`),
    check('personal_events_outcome_iff_done', sql`(${t.state} = 'active') = (${t.outcome} is null)`),
    check('personal_events_roll_iff_resolved', sql`(${t.state} = 'resolved') = (${t.roll} is not null)`),
    check('personal_events_roll_range', sql`${t.roll} is null or (${t.roll} >= 0 and ${t.roll} < 100)`),
    check('personal_events_resolved_time_iff_done', sql`(${t.state} = 'active') = (${t.resolvedAtMinutes} is null)`),
    check('personal_events_unresolved_is_failure', sql`${t.state} = 'resolved' or ${t.outcome} is null or ${t.outcome} = 'failure'`),
    check('personal_events_chance_range', sql`${t.chancePercent} between 0 and 100`),
    check('personal_events_times', sql`${t.createdAtMinutes} >= 0 and ${t.expiresAtMinutes} >= ${t.createdAtMinutes}`),
    check('personal_events_lock_consistent', sql`(${t.lockLocationId} is null) = (${t.lockUntilMinutes} is null) and (${t.lockLocationId} is null) = (${t.lockReason} is null)`),
    check('personal_events_lock_flag', sql`${t.lockReleased} in (0, 1)`),
    check('personal_events_intent_len', sql`length(${t.intent}) between 1 and 80`),
    check('personal_events_proposal_json', sql`json_valid(${t.proposalJson})`),
  ],
);

/**
 * 游戏时钟：单行（id = 'main'），整数游戏分钟，只增不减（单调性由存档层的 advance 保证，
 * 这里的约束只兜底非负）。与 world_clock（现实时间高水位）无关。
 */
export const gameClock = sqliteTable(
  'game_clock',
  {
    id: text('id').primaryKey(),
    minutes: integer('minutes').notNull(),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [check('game_clock_single', sql`${t.id} = 'main'`), check('game_clock_nonneg', sql`${t.minutes} >= 0`)],
);

/**
 * 地点的可变状态（权威存档）。名字、地区、描述来自静态定义。
 * 约束：封锁当且仅当有原因（原因 ≤60 字）；visited 只能是 0/1。
 */
export const locations = sqliteTable(
  'locations',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull(),
    reason: text('reason'),
    visited: integer('visited').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [
    check('locations_id_format', sql`${t.id} glob 'loc_*' and length(${t.id}) <= 64`),
    check('locations_status_valid', sql`${t.status} in (${locationStatusList})`),
    check('locations_reason_rule', sql`(${t.status} = 'blocked') = (${t.reason} is not null)`),
    check('locations_reason_len', sql`${t.reason} is null or length(${t.reason}) between 1 and 60`),
    check('locations_visited_flag', sql`${t.visited} in (0, 1)`),
  ],
);
