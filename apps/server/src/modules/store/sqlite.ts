import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import {
  ActionResponseSchema,
  LogRecordSchema,
  NpcMemorySchema,
  NpcStateSchema,
  PlayerStateSchema,
  RelationshipSchema,
  type AuditEvent,
  type Honorific,
  type LogRecord,
  type NpcMemory,
  type NpcState,
  type PlayerState,
  type Relationship,
} from '@jhz/contracts';
import { INITIAL_INVENTORY, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import type { Db } from '../../db/connection.js';
import { actions, aiCallLogs, auditEvents, cultivationJobs, inventory, npcMemories, npcRelationships, npcs, playerStates, quests, players, worldClock } from '../../db/schema.js';
import { AppError } from '../../shared/errors.js';
import type { ImportedMemory } from './world-rules.js';
import { applyQuestPatch, assertClaimable, assertQuest, initialQuestRecords, toQuestState, type QuestRecord, assertLocation, assertNpc, assertStatus, assertTarget, compactMemories, validateMemoryInput, initialNpcs, initialRelationships, nextRelationship } from './world-rules.js';
import type { AiCallRecord, CultivationJobRecord, GameStore, GameTx, StoredAction } from './types.js';

/** 单机固定的玩家 ID */
export const PLAYER_ID = 'player_1';

/** Drizzle 的数据库句柄与事务句柄共有的查询接口 */
type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

const toJson = (h: Honorific | null): string | null => (h ? JSON.stringify(h) : null);
const fromJson = (s: string | null): unknown => (s ? JSON.parse(s) : null);

function toRow(s: PlayerState, version: number) {
  return {
    realm: s.realm,
    realmProgress: s.realmProgress,
    hp: s.hp,
    maxHp: s.maxHp,
    stamina: s.stamina,
    maxStamina: s.maxStamina,
    neiliCurrent: s.neili?.current ?? null,
    neiliMax: s.neili?.max ?? null,
    yuanbao: s.currency.yuanbao,
    silver: s.currency.silver,
    copper: s.currency.copper,
    attributesJson: JSON.stringify(s.attributes),
    titleJson: toJson(s.title),
    epithetJson: toJson(s.epithet),
    fateJson: toJson(s.fate),
    locationId: s.location.id,
    locationName: s.location.name,
    breakthroughAvailableAt: s.breakthroughAvailableAt,
    version,
  };
}

function readPlayer(db: Executor): PlayerState {
  const row = db
    .select()
    .from(playerStates)
    .innerJoin(players, eq(playerStates.playerId, players.id))
    .where(eq(playerStates.playerId, PLAYER_ID))
    .get();
  if (!row) throw new Error('存档缺少玩家数据，请先运行迁移与初始化');
  const s = row.player_states;
  // 读出的数据同样经过契约校验，损坏的存档不会悄悄进入游戏
  return PlayerStateSchema.parse({
    displayName: row.players.displayName,
    realm: s.realm,
    realmProgress: s.realmProgress,
    hp: s.hp,
    maxHp: s.maxHp,
    stamina: s.stamina,
    maxStamina: s.maxStamina,
    neili: s.neiliCurrent === null || s.neiliMax === null ? null : { current: s.neiliCurrent, max: s.neiliMax },
    currency: { yuanbao: s.yuanbao, silver: s.silver, copper: s.copper },
    attributes: JSON.parse(s.attributesJson),
    title: fromJson(s.titleJson),
    epithet: fromJson(s.epithetJson),
    fate: fromJson(s.fateJson),
    location: { id: s.locationId, name: s.locationName },
    breakthroughAvailableAt: s.breakthroughAvailableAt,
    version: s.version,
  });
}

function makeTx(db: Executor): GameTx {
  const qty = (itemId: string): number =>
    db
      .select({ q: inventory.quantity })
      .from(inventory)
      .where(and(eq(inventory.playerId, PLAYER_ID), eq(inventory.itemId, itemId)))
      .get()?.q ?? 0;
  const setQty = (itemId: string, quantity: number) =>
    db
      .insert(inventory)
      .values({ playerId: PLAYER_ID, itemId, quantity })
      .onConflictDoUpdate({ target: [inventory.playerId, inventory.itemId], set: { quantity, updatedAt: Date.now() } })
      .run();

  return {
    player: () => readPlayer(db),
    savePlayer(next) {
      const valid = PlayerStateSchema.parse(next);
      const res = db
        .update(playerStates)
        .set({ ...toRow(valid, valid.version + 1), updatedAt: Date.now() })
        .where(and(eq(playerStates.playerId, PLAYER_ID), eq(playerStates.version, valid.version)))
        .run();
      if (res.changes === 0) throw new AppError('CONFLICT', '角色状态已变化，请刷新后重试');
      db.update(players).set({ displayName: valid.displayName, updatedAt: Date.now() }).where(eq(players.id, PLAYER_ID)).run();
      return readPlayer(db);
    },
    inventory: () =>
      toInventoryItems(db.select({ itemId: inventory.itemId, quantity: inventory.quantity }).from(inventory).where(eq(inventory.playerId, PLAYER_ID)).all()),
    takeItem(itemId, quantity) {
      const have = qty(itemId);
      if (!Number.isInteger(quantity) || quantity <= 0 || have < quantity) throw new AppError('PRECONDITION_FAILED', '物品数量不足');
      setQty(itemId, have - quantity);
    },
    addItem(itemId, quantity) {
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('物品数量必须为正整数');
      const next = qty(itemId) + quantity;
      if (next > 9999) throw new AppError('PRECONDITION_FAILED', '物品数量超过上限');
      setQty(itemId, next);
    },
    runningJob() {
      const r = db
        .select()
        .from(cultivationJobs)
        .where(and(eq(cultivationJobs.playerId, PLAYER_ID), eq(cultivationJobs.status, 'running')))
        .get();
      return r
        ? {
            id: r.id,
            methodId: r.methodId,
            status: 'running',
            startedAt: r.startedAt,
            lastSettledAt: r.lastSettledAt,
            lastCheckedAt: r.lastCheckedAt ?? r.lastSettledAt, // 旧数据没有接触时间，按结算点处理
          }
        : null;
    },
    saveJob(job: CultivationJobRecord) {
      const values = {
        id: job.id,
        playerId: PLAYER_ID,
        methodId: job.methodId,
        status: job.status,
        startedAt: job.startedAt,
        lastSettledAt: job.lastSettledAt,
        lastCheckedAt: job.lastCheckedAt,
      };
      db.insert(cultivationJobs)
        .values(values)
        .onConflictDoUpdate({ target: cultivationJobs.id, set: { status: job.status, lastSettledAt: job.lastSettledAt, lastCheckedAt: job.lastCheckedAt, updatedAt: Date.now() } })
        .run();
    },

    quests: () => readQuests(db).map(toQuestState),
    updateQuest(id, patch, at) {
      assertQuest(id);
      const next = applyQuestPatch(readQuest(db, id), patch, at);
      writeQuest(db, next);
      return toQuestState(next);
    },
    markQuestClaimed(id, at) {
      assertQuest(id);
      const cur = readQuest(db, id);
      assertClaimable(cur);
      const next = { ...cur, claimedAt: at };
      writeQuest(db, next);
      return toQuestState(next);
    },
    memories: (npcId) => readMemories(db, npcId),
    memoryCounts() {
      const out: Record<string, number> = Object.fromEntries(readNpcs(db).map((n) => [n.id, 0]));
      for (const r of db.select({ npcId: npcMemories.npcId, n: count() }).from(npcMemories).groupBy(npcMemories.npcId).all()) out[r.npcId] = r.n;
      return out;
    },
    addMemory(input) {
      assertNpc(input.npcId);
      validateMemoryInput(input);
      if (!db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.id, input.eventId)).get()) throw new AppError('NOT_FOUND', '记忆引用的事件不存在');
      const mem = NpcMemorySchema.parse({ id: randomUUID(), npcId: input.npcId, eventId: input.eventId, type: input.type, summary: input.summary, importance: input.importance, sourceCount: 1, createdAt: input.at });
      db.insert(npcMemories).values({ id: mem.id, npcId: mem.npcId, eventId: mem.eventId, memoryType: mem.type, summary: mem.summary, importance: mem.importance, sourceCount: mem.sourceCount, createdAt: mem.createdAt }).run();
      compactMemories(
        () => readMemories(db, input.npcId),
        (plan) => {
          for (const id of plan.mergeIds) db.delete(npcMemories).where(eq(npcMemories.id, id)).run();
          const sum = NpcMemorySchema.parse({ id: randomUUID(), npcId: input.npcId, eventId: null, type: 'summary', ...plan.summary });
          db.insert(npcMemories).values({ id: sum.id, npcId: sum.npcId, eventId: null, memoryType: 'summary', summary: sum.summary, importance: sum.importance, sourceCount: sum.sourceCount, createdAt: sum.createdAt }).run();
        },
      );
      return readMemories(db, input.npcId).find((m) => m.id === mem.id) ?? mem;
    },
    npcs: () => readNpcs(db),
    relationships: () => readRelationships(db),
    adjustRelationship(npcId, target, delta) {
      assertNpc(npcId);
      assertTarget(npcId, target.type, target.id);
      const cur = readRelationships(db).find((r) => r.npcId === npcId && r.targetType === target.type && r.targetId === target.id);
      const next = nextRelationship(cur, npcId, target.type, target.id, delta);
      db.insert(npcRelationships)
        .values({ npcId, targetType: target.type, targetId: target.id, affinity: next.affinity, trust: next.trust, hostility: next.hostility })
        .onConflictDoUpdate({
          target: [npcRelationships.npcId, npcRelationships.targetType, npcRelationships.targetId],
          set: { affinity: next.affinity, trust: next.trust, hostility: next.hostility, updatedAt: Date.now() },
        })
        .run();
      return next;
    },
    moveNpc(npcId, locationId) {
      assertNpc(npcId);
      assertLocation(locationId);
      const res = db.update(npcs).set({ locationId, updatedAt: Date.now() }).where(eq(npcs.id, npcId)).run();
      if (res.changes === 0) throw new AppError('NOT_FOUND', '没有这个人物');
      return readNpcs(db).find((n) => n.id === npcId)!;
    },
    setNpcStatus(npcId, status) {
      assertNpc(npcId);
      assertStatus(status);
      const res = db.update(npcs).set({ status, updatedAt: Date.now() }).where(eq(npcs.id, npcId)).run();
      if (res.changes === 0) throw new AppError('NOT_FOUND', '没有这个人物');
      return readNpcs(db).find((n) => n.id === npcId)!;
    },

    findActionByKey(key) {
      const r = db.select().from(actions).where(and(eq(actions.playerId, PLAYER_ID), eq(actions.idempotencyKey, key))).get();
      return r ? rowToAction(r) : null;
    },
    getAction(id) {
      const r = db.select().from(actions).where(and(eq(actions.playerId, PLAYER_ID), eq(actions.id, id))).get();
      return r ? rowToAction(r) : null;
    },
    saveAction(a: StoredAction) {
      const values = {
        id: a.id,
        playerId: PLAYER_ID,
        idempotencyKey: a.idempotencyKey,
        kind: a.kind,
        fingerprint: a.fingerprint,
        status: a.status,
        responseJson: JSON.stringify(a.response),
        createdAt: a.createdAt,
      };
      db.insert(actions)
        .values(values)
        .onConflictDoUpdate({ target: actions.id, set: { status: a.status, responseJson: values.responseJson, updatedAt: Date.now() } })
        .run();
    },
    appendEvent(input) {
      const row = db
        .insert(auditEvents)
        .values({
          id: input.id ?? randomUUID(),
          actorId: PLAYER_ID,
          actionId: input.actionId,
          eventType: input.eventType,
          beforeJson: input.before ? JSON.stringify(input.before) : null,
          afterJson: input.after ? JSON.stringify(input.after) : null,
          logJson: null,
          createdAt: input.at,
        })
        .returning({ seq: auditEvents.seq })
        .get();
      if (!input.log) return null;
      const log = LogRecordSchema.parse({ ...input.log, id: row.seq, at: input.at });
      db.update(auditEvents).set({ logJson: JSON.stringify(log) }).where(eq(auditEvents.seq, row.seq)).run();
      return log;
    },
    replaceLogNarrative(actionId, narrative) {
      const row = db
        .select({ seq: auditEvents.seq, logJson: auditEvents.logJson })
        .from(auditEvents)
        .where(and(eq(auditEvents.actionId, actionId), isNotNull(auditEvents.logJson)))
        .orderBy(asc(auditEvents.seq))
        .get();
      if (!row) return null;
      const prev = JSON.parse(row.logJson!);
      const log = LogRecordSchema.parse({ ...prev, narrative, ...(prev.narration ? { narration: { ...prev.narration, pending: false } } : {}) });
      db.update(auditEvents).set({ logJson: JSON.stringify(log) }).where(eq(auditEvents.seq, row.seq)).run();
      return log;
    },
    recentLog(limit) {
      const rows = db
        .select({ logJson: auditEvents.logJson })
        .from(auditEvents)
        .where(and(eq(auditEvents.actorId, PLAYER_ID), isNotNull(auditEvents.logJson)))
        .orderBy(desc(auditEvents.seq))
        .limit(limit)
        .all();
      return rows.reverse().map((r) => LogRecordSchema.parse(JSON.parse(r.logJson!)));
    },
    eventsForAction(actionId) {
      return db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionId, actionId))
        .orderBy(asc(auditEvents.seq))
        .all()
        .map(
          (r): AuditEvent => ({
            seq: r.seq,
            id: r.id,
            actorId: r.actorId,
            actionId: r.actionId,
            eventType: r.eventType,
            before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
            after: r.afterJson ? JSON.parse(r.afterJson) : null,
            at: r.createdAt,
          }),
        );
    },
  };
}

function rowToAction(r: typeof actions.$inferSelect): StoredAction {
  return {
    id: r.id,
    kind: r.kind as StoredAction['kind'],
    idempotencyKey: r.idempotencyKey,
    fingerprint: r.fingerprint,
    status: r.status as StoredAction['status'],
    // 读出时同样校验，损坏的记录不会被当作「首次结果」回放
    // 旧版本写入的响应没有后续新增的字段（如 ai），读取时补上默认值，保证旧存档的幂等回放继续可用
    response: ActionResponseSchema.parse({ ai: null, ...JSON.parse(r.responseJson) }),
    createdAt: r.createdAt,
  };
}

function readNpcs(db: Executor): NpcState[] {
  return db
    .select()
    .from(npcs)
    .orderBy(asc(npcs.id))
    .all()
    // 读出时同样校验，损坏的记录不会悄悄进入游戏
    .map((r) => NpcStateSchema.parse({ id: r.id, locationId: r.locationId, status: r.status, goals: JSON.parse(r.goalsJson) }));
}

const toQuestRecord = (r: typeof quests.$inferSelect): QuestRecord => ({ id: r.id, status: r.status as QuestRecord['status'], stepIndex: r.stepIndex, acceptedAt: r.acceptedAt, finishedAt: r.finishedAt, claimedAt: r.claimedAt });
function readQuests(db: Executor): QuestRecord[] {
  return db.select().from(quests).orderBy(asc(quests.id)).all().map(toQuestRecord);
}
function readQuest(db: Executor, id: string): QuestRecord {
  const r = db.select().from(quests).where(eq(quests.id, id)).get();
  if (!r) throw new AppError('NOT_FOUND', '没有这个任务');
  return toQuestRecord(r);
}
function writeQuest(db: Executor, q: QuestRecord): void {
  db.update(quests).set({ status: q.status, stepIndex: q.stepIndex, acceptedAt: q.acceptedAt, finishedAt: q.finishedAt, claimedAt: q.claimedAt, updatedAt: Date.now() }).where(eq(quests.id, q.id)).run();
}

function readMemories(db: Executor, npcId: string): NpcMemory[] {
  return db
    .select()
    .from(npcMemories)
    .where(eq(npcMemories.npcId, npcId))
    .orderBy(asc(npcMemories.createdAt), asc(npcMemories.id))
    .all()
    .map((r) => NpcMemorySchema.parse({ id: r.id, npcId: r.npcId, eventId: r.eventId, type: r.memoryType, summary: r.summary, importance: r.importance, sourceCount: r.sourceCount, createdAt: r.createdAt }));
}

function readRelationships(db: Executor): Relationship[] {
  return db
    .select()
    .from(npcRelationships)
    .orderBy(asc(npcRelationships.npcId), asc(npcRelationships.targetType), asc(npcRelationships.targetId))
    .all()
    .map((r) => RelationshipSchema.parse({ npcId: r.npcId, targetType: r.targetType, targetId: r.targetId, affinity: r.affinity, trust: r.trust, hostility: r.hostility }));
}

/** 直接写入（覆盖）整个角色状态并指定版本；仅供导入存档使用 */
export function writePlayerState(db: Db, state: PlayerState): void {
  const valid = PlayerStateSchema.parse(state);
  db.transaction(
    (tx) => {
      tx.insert(players)
        .values({ id: PLAYER_ID, displayName: valid.displayName })
        .onConflictDoUpdate({ target: players.id, set: { displayName: valid.displayName, updatedAt: Date.now() } })
        .run();
      tx.insert(playerStates)
        .values({ playerId: PLAYER_ID, ...toRow(valid, valid.version) })
        .onConflictDoUpdate({ target: playerStates.playerId, set: { ...toRow(valid, valid.version), updatedAt: Date.now() } })
        .run();
    },
    { behavior: 'immediate' },
  );
}

/** 覆盖写入 NPC 状态与关系（导入存档用）；world 为 null 表示重置为初始。世界数据须已通过 mergeImportedWorld 校验 */
export function writeWorldState(db: Db, world: { npcs: NpcState[]; relationships: Relationship[]; memories: ImportedMemory[]; quests: QuestRecord[] } | null): void {
  const w = world ?? { npcs: initialNpcs(), relationships: initialRelationships(), memories: [], quests: initialQuestRecords() };
  db.transaction(
    (tx) => {
      tx.delete(npcRelationships).run();
      tx.delete(npcMemories).run(); // 旧记忆引用的是旧存档的事件，整体替换
      for (const n of w.npcs) {
        const v = { locationId: n.locationId, status: n.status, goalsJson: JSON.stringify(n.goals) };
        tx.insert(npcs).values({ id: n.id, ...v }).onConflictDoUpdate({ target: npcs.id, set: { ...v, updatedAt: Date.now() } }).run();
      }
      for (const r of w.relationships) tx.insert(npcRelationships).values(r).run();
      tx.delete(quests).run();
      for (const q of w.quests) tx.insert(quests).values(q).run();
      for (const m of w.memories) {
        tx.insert(npcMemories).values({ id: randomUUID(), npcId: m.npcId, eventId: null, memoryType: 'summary', summary: m.summary, importance: m.importance, sourceCount: m.sourceCount, createdAt: m.createdAt }).run();
      }
    },
    { behavior: 'immediate' },
  );
}

/** 首次启动写入初始角色与初始库存；已有数据不做任何修改（库存行存在即不再补发） */
export function ensureSeed(db: Db, initial: PlayerState = createInitialPlayer()): void {
  const valid = PlayerStateSchema.parse(initial);
  db.transaction(
    (tx) => {
      tx.insert(players).values({ id: PLAYER_ID, displayName: valid.displayName }).onConflictDoNothing().run();
      tx.insert(playerStates)
        .values({ playerId: PLAYER_ID, ...toRow(valid, valid.version) })
        .onConflictDoNothing()
        .run();
      for (const it of INITIAL_INVENTORY) {
        tx.insert(inventory).values({ playerId: PLAYER_ID, itemId: it.itemId, quantity: it.quantity }).onConflictDoNothing().run();
      }
      // 世界：只补齐缺失的 NPC 与关系，已有的状态（地点、关系数值）一律不覆盖
      for (const n of initialNpcs()) {
        tx.insert(npcs).values({ id: n.id, locationId: n.locationId, status: n.status, goalsJson: JSON.stringify(n.goals) }).onConflictDoNothing().run();
      }
      for (const r of initialRelationships()) {
        tx.insert(npcRelationships).values(r).onConflictDoNothing().run();
      }
      for (const q of initialQuestRecords()) {
        tx.insert(quests).values(q).onConflictDoNothing().run();
      }
    },
    { behavior: 'immediate' },
  );
}

export function createSqliteGameStore(db: Db, initial?: PlayerState): GameStore {
  ensureSeed(db, initial);
  return {
    aiLog: {
      reserve(e) {
        const id = randomUUID();
        db.insert(aiCallLogs).values({ id, actionId: e.actionId, purpose: e.purpose, provider: e.provider, model: e.model, day: e.day, status: 'pending', requestChars: e.requestChars, createdAt: e.at }).run();
        return id;
      },
      finish(id, r) {
        db.update(aiCallLogs)
          .set({ status: r.status, errorKind: r.errorKind, attempts: r.attempts, latencyMs: r.latencyMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens, totalTokens: r.totalTokens, responseChars: r.responseChars })
          .where(eq(aiCallLogs.id, id))
          .run();
      },
      usedOn: (day, purpose) =>
        db
          .select({ n: count() })
          .from(aiCallLogs)
          .where(purpose ? and(eq(aiCallLogs.day, day), eq(aiCallLogs.purpose, purpose)) : eq(aiCallLogs.day, day))
          .get()?.n ?? 0,
      recent: (limit) =>
        db
          .select()
          .from(aiCallLogs)
          .orderBy(desc(aiCallLogs.createdAt), desc(aiCallLogs.id))
          .limit(limit)
          .all()
          .map((r): AiCallRecord => ({ ...r, purpose: r.purpose as AiCallRecord['purpose'], status: r.status as AiCallRecord['status'] })),
    },
    worldClock: {
      load: () => db.select({ t: worldClock.highWaterAt }).from(worldClock).where(eq(worldClock.id, 'main')).get()?.t ?? null,
      save: (t) => {
        db.insert(worldClock)
          .values({ id: 'main', highWaterAt: t })
          .onConflictDoUpdate({ target: worldClock.id, set: { highWaterAt: t, updatedAt: Date.now() } })
          .run();
      },
    },
    read: (fn) => db.transaction((tx) => fn(makeTx(tx)), { behavior: 'deferred' }),
    transact: (fn) => db.transaction((tx) => fn(makeTx(tx)), { behavior: 'immediate' }),
  };
}
