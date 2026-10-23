import { randomUUID } from 'node:crypto';
import { CultivationResponseSchema, type CultivationResponse, type StateChange } from '@jhz/contracts';
import { DEFAULT_METHOD_ID, IDLE_CULTIVATION, OFFLINE, settleIdleCultivation } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/runtime.js';
import type { CultivationJobRecord, GameStore, GameTx } from '../store/types.js';

export interface OfflinePolicy {
  /** 距上次接触超过该时长视为离线 */
  thresholdMs: number;
  /** 离线单次结算最多计入的时长 */
  capMs: number;
  /** 离线收益效率（0–1） */
  efficiency: number;
}

export interface CultivationDeps {
  store: GameStore;
  clock: Clock;
  /** 覆盖默认离线策略（测试用） */
  offline?: Partial<OfflinePolicy>;
}

type OfflineInfo = NonNullable<CultivationResponse['offline']>;

interface Settled {
  changes: StateChange[];
  ticks: number;
  offline: OfflineInfo | null;
  notice: string | null;
}

const NONE: Settled = { changes: [], ticks: 0, offline: null, notice: null };

export function createCultivationService({ store, clock, offline }: CultivationDeps) {
  const policy: OfflinePolicy = { ...OFFLINE, ...offline };

  /**
   * 事务内结算运行中的修炼：
   * - 距上次接触超过阈值按离线处理：单次最多计入 capMs，按 efficiency 折算，超出部分作废；
   * - 在线只消耗产出收益所需的时间片，零头保留；离线不保留零头；
   * - 时钟回拨（now 早于记录）按 0 处理，且不让记录倒退；
   * - 每次调用都更新「上次接触」，进度圆满则自动停止。
   */
  function settleInTx(tx: GameTx, now: number): Settled {
    const job = tx.runningJob();
    if (!job) return NONE;

    const gap = Math.max(0, now - job.lastCheckedAt);
    const isOffline = gap > policy.thresholdMs;
    const sinceSettled = Math.max(0, now - job.lastSettledAt);
    const counted = isOffline ? Math.min(sinceSettled, policy.capMs) : sinceSettled;
    const efficiency = isOffline ? policy.efficiency : 1;
    const ticks = Math.floor(counted / IDLE_CULTIVATION.tickMs);

    const result = ticks > 0 ? settleIdleCultivation(tx.player(), job.methodId, ticks, efficiency) : null;
    const paid = !!result && (result.ticksUsed > 0 || result.completed);

    // 在线：新结算点 = now − 未消耗的零头，零头留到下次按全额结算。
    // 离线：不保留零头，结算点直接推进到 now（超出上限的部分一并作废）——
    // 否则以 50% 效率结算后剩下的零头会在下次在线结算时按 100% 重新计价。
    let lastSettledAt = job.lastSettledAt;
    if (isOffline) {
      lastSettledAt = Math.max(job.lastSettledAt, now);
    } else if (paid) {
      lastSettledAt = Math.max(job.lastSettledAt, now - (counted - result.ticksUsed * IDLE_CULTIVATION.tickMs));
    }
    const next: CultivationJobRecord = { ...job, lastSettledAt, lastCheckedAt: Math.max(job.lastCheckedAt, now) };

    if (result && result.changes.length > 0) tx.savePlayer(result.player);
    const info: OfflineInfo | null = isOffline
      ? { gapMs: gap, countedMs: counted, capped: sinceSettled > counted, efficiencyPercent: Math.round(efficiency * 100) }
      : null;

    if (result?.completed) {
      tx.saveJob({ ...next, status: 'stopped' });
      return { changes: result.changes, ticks: result.ticksUsed, offline: info, notice: '修炼已圆满，可以尝试突破了' };
    }
    tx.saveJob(next);
    return { changes: result?.changes ?? [], ticks: result?.ticksUsed ?? 0, offline: info, notice: null };
  }

  function respond(tx: GameTx, settled: Settled, now: number): CultivationResponse {
    const job = tx.runningJob();
    return CultivationResponseSchema.parse({
      job: job ? { methodId: job.methodId, status: job.status, startedAt: job.startedAt, lastSettledAt: job.lastSettledAt } : null,
      player: tx.player(),
      changes: settled.changes,
      ticks: settled.ticks,
      serverNow: now,
      offline: settled.offline,
      notice: settled.notice,
    });
  }

  return {
    policy,

    /** 查询当前状态，不结算 */
    get: (): CultivationResponse => {
      const now = clock.now();
      return store.read((tx) => respond(tx, NONE, now));
    },

    /** 开始放置修炼；已在修炼时保持不变（幂等） */
    start: (): CultivationResponse => {
      const now = clock.now();
      return store.transact((tx) => {
        if (!tx.runningJob()) {
          if (tx.player().realmProgress >= 100) throw new AppError('PRECONDITION_FAILED', '修炼已圆满，请先尝试突破');
          tx.saveJob({ id: randomUUID(), methodId: DEFAULT_METHOD_ID, status: 'running', startedAt: now, lastSettledAt: now, lastCheckedAt: now });
        }
        return respond(tx, NONE, now);
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
