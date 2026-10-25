import { IDLE_CULTIVATION, settleIdleCultivation } from '@jhz/game-rules';
import type { CultivationJob, PlayerState } from '@jhz/contracts';

export interface IdlePreview {
  /** 已累计的完整分钟数（时间片） */
  minutes: number;
  /** 当前可领取的经验（进度百分点）；与服务端同一套规则，仅作展示 */
  progressGain: number;
}

/** 放置修炼的可领取预览；以服务端时钟为准（now = 本机时间 + 服务端偏移） */
export function idlePreview(player: PlayerState, job: CultivationJob, now: number): IdlePreview {
  const ticks = Math.floor(Math.max(0, now - job.lastSettledAt) / IDLE_CULTIVATION.tickMs);
  const r = settleIdleCultivation(player, job.methodId, ticks);
  return { minutes: ticks, progressGain: r.changes.find((c) => c.stat === 'realmProgress')?.delta ?? 0 };
}
