import { and, eq } from 'drizzle-orm';
import { PlayerStateSchema, type Honorific, type PlayerState } from '@jhz/contracts';
import { createInitialPlayer } from '@jhz/game-rules';
import type { Db } from '../../db/connection.js';
import { playerStates, players } from '../../db/schema.js';
import { AppError } from '../../shared/errors.js';
import type { PlayerStore } from './store.js';

/** 单机固定的玩家 ID */
export const PLAYER_ID = 'player_1';

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

function read(db: Db): PlayerState {
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

/** 直接写入（覆盖）整个角色状态并指定版本；仅供导入存档与初始化使用 */
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

/** 首次启动写入初始角色；已有存档时不做任何修改 */
export function ensureSeed(db: Db, initial: PlayerState = createInitialPlayer()): void {
  const valid = PlayerStateSchema.parse(initial);
  db.transaction(
    (tx) => {
      tx.insert(players).values({ id: PLAYER_ID, displayName: valid.displayName }).onConflictDoNothing().run();
      tx.insert(playerStates)
        .values({ playerId: PLAYER_ID, ...toRow(valid, valid.version) })
        .onConflictDoNothing()
        .run();
    },
    { behavior: 'immediate' },
  );
}

export function createSqlitePlayerStore(db: Db, initial?: PlayerState): PlayerStore {
  ensureSeed(db, initial);
  return {
    get: () => read(db),
    commit(next, expectedVersion) {
      const valid = PlayerStateSchema.parse(next);
      db.transaction(
        (tx) => {
          const res = tx
            .update(playerStates)
            .set({ ...toRow(valid, expectedVersion + 1), updatedAt: Date.now() })
            .where(and(eq(playerStates.playerId, PLAYER_ID), eq(playerStates.version, expectedVersion)))
            .run();
          if (res.changes === 0) throw new AppError('CONFLICT', '角色状态已变化，请刷新后重试');
          tx.update(players).set({ displayName: valid.displayName, updatedAt: Date.now() }).where(eq(players.id, PLAYER_ID)).run();
        },
        { behavior: 'immediate' },
      );
      return read(db);
    },
  };
}
