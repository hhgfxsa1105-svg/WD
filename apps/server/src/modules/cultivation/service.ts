import { randomUUID } from 'node:crypto';
import { CultivationResponseSchema, type CultivationResponse, type StateChange } from '@jhz/contracts';
import { DEFAULT_METHOD_ID, IDLE_CULTIVATION, settleIdleCultivation } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/runtime.js';
import type { CultivationJobRecord, GameStore, GameTx } from '../store/types.js';

export interface CultivationDeps {
  store: GameStore;
  clock: Clock;
  /** 单次结算最多计入的时长（离线上限），T-009 配置；默认不设上限 */
  maxElapsedMs?: number;
}

interface Settled {
  changes: StateChange[];
  ticks: number;
  notice: string | null;
}

export function createCultivationService({ store, clock, maxElapsedMs }: CultivationDeps) {
  /**
   * 事务内结算运行中的修炼：只消耗产出收益所需的时间片，零头保留；
   * 超过离线上限的时间直接作废；进度圆满则自动停止。
   */
  function settleInTx(tx: GameTx, now: number): Settled {
    const job = tx.runningJob();
    if (!job) return { changes: [], ticks: 0, notice: null };

    const elapsed = Math.max(0, now - job.lastSettledAt); // 时钟回拨按 0 处理
    const counted = Math.min(elapsed, maxElapsedMs ?? Number.POSITIVE_INFINITY);
    const ticks = Math.floor(counted / IDLE_CULTIVATION.tickMs);
    if (ticks === 0) return { changes: [], ticks: 0, notice: null };

    const result = settleIdleCultivation(tx.player(), job.methodId, ticks);
    if (result.ticksUsed === 0 && !result.completed) {
      // 本次没有可领取的收益：保持原结算点；若已超过离线上限，作废超出部分
      if (elapsed > counted) tx.saveJob({ ...job, lastSettledAt: now - counted });
      return { changes: [], ticks: 0, notice: null };
    }
    if (result.changes.length > 0) tx.savePlayer(result.player);

    // 新结算点 = now − 未消耗的零头（零头 = 可计入时长 − 已消耗时长）
    const leftover = counted - result.ticksUsed * IDLE_CULTIVATION.tickMs;
    const advanced: CultivationJobRecord = { ...job, lastSettledAt: Math.max(job.lastSettledAt, now - leftover) };
    if (result.completed) {
      tx.saveJob({ ...advanced, status: 'stopped' });
      return { changes: result.changes, ticks: result.ticksUsed, notice: '修炼已圆满，可以尝试突破了' };
    }
    tx.saveJob(advanced);
    return { changes: result.changes, ticks: result.ticksUsed, notice: null };
  }

  function respond(tx: GameTx, settled: Settled, now: number): CultivationResponse {
    const job = tx.runningJob();
    return CultivationResponseSchema.parse({
      job: job ? { methodId: job.methodId, status: job.status, startedAt: job.startedAt, lastSettledAt: job.lastSettledAt } : null,
      player: tx.player(),
      changes: settled.changes,
      ticks: settled.ticks,
      serverNow: now,
      notice: settled.notice,
    });
  }

  const none: Settled = { changes: [], ticks: 0, notice: null };

  return {
    /** 查询当前状态，不结算 */
    get: (): CultivationResponse => {
      const now = clock.now();
      return store.read((tx) => respond(tx, none, now));
    },

    /** 开始放置修炼；已在修炼时保持不变（幂等） */
    start: (): CultivationResponse => {
      const now = clock.now();
      return store.transact((tx) => {
        if (!tx.runningJob()) {
          if (tx.player().realmProgress >= 100) throw new AppError('PRECONDITION_FAILED', '修炼已圆满，请先尝试突破');
          tx.saveJob({ id: randomUUID(), methodId: DEFAULT_METHOD_ID, status: 'running', startedAt: now, lastSettledAt: now });
        }
        return respond(tx, none, now);
      });
    },

    /** 领取已累计的修炼收益；重复调用不会重复领取 */
    settle: (): CultivationResponse => {
      const now = clock.now();
      return store.transact((tx) => respond(tx, settleInTx(tx, now), now));
    },

    /** 结算后停止；没有进行中的修炼时保持不变（幂等） */
    stop: (): CultivationResponse => {
      const now = clock.now();
      return store.transact((tx) => {
        const settled = settleInTx(tx, now);
        const job = tx.runningJob();
        if (job) tx.saveJob({ ...job, status: 'stopped' });
        return respond(tx, settled, now);
      });
    },
  };
}

export type CultivationService = ReturnType<typeof createCultivationService>;
