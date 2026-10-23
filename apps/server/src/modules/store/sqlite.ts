import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import {
  ActionResponseSchema,
  LogRecordSchema,
  PlayerStateSchema,
  type AuditEvent,
  type Honorific,
  type LogRecord,
  type PlayerState,
} from '@jhz/contracts';
import { INITIAL_INVENTORY, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import type { Db } from '../../db/connection.js';
import { actions, aiCallLogs, auditEvents, cultivationJobs, inventory, playerStates, players, worldClock } from '../../db/schema.js';
import { AppError } from '../../shared/errors.js';
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
          id: randomUUID(),
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
      const log = LogRecordSchema.parse({ ...JSON.parse(row.logJson!), narrative });
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
