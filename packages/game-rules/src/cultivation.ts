import { realmHasNeili, type Grade, type PlayerState, type StateChange } from '@jhz/contracts';
import { expBonusPercent } from './actions.js';
import { IDLE_CULTIVATION, METHOD_EXP_COEFFICIENT } from './tables.js';

/** 功法定义（功法系统接入前仅一部基础功法） */
export const METHODS: Record<string, { name: string; grade: Grade }> = {
  basic_breathing: { name: '基础吐纳法', grade: 'fan' },
};
export const DEFAULT_METHOD_ID = 'basic_breathing';

export interface IdleSettlement {
  player: PlayerState;
  changes: StateChange[];
  /** 本次实际消耗的时间片；产出为 0 时为 0，零头时间保留到下次，因此频繁结算既不吃亏也不占便宜 */
  ticksUsed: number;
  /** 进度已满，放置修炼应自动停止 */
  completed: boolean;
}

/**
 * 放置修炼结算（纯函数）。ticks 为可计入的完整时间片数。
 * 进度 = floor(ticks × 每片进度 × 功法系数 × (1+名号加成))；只消耗产出这些进度所需的最少时间片。
 * 后天及以上同时按已消耗的时间片获得内力。进度封顶 100，内力封顶上限。
 * efficiency 为收益效率（在线 1，离线见 OFFLINE.efficiency），进度与内力同比缩放。
 */
export function settleIdleCultivation(player: PlayerState, methodId: string, ticks: number, efficiency = 1): IdleSettlement {
  const method = METHODS[methodId];
  if (!method) throw new Error(`未知功法：${methodId}`);
  const none = { player, changes: [], ticksUsed: 0, completed: player.realmProgress >= 100 };
  if (ticks <= 0 || player.realmProgress >= 100) return none;

  const coef = METHOD_EXP_COEFFICIENT[method.grade];
  const bonus = Math.max(-90, expBonusPercent(player));
  const perTick = (IDLE_CULTIVATION.progressPerTick * coef * efficiency * (100 + bonus)) / 100;
  const raw = Math.floor(ticks * perTick + 1e-9);
  if (raw <= 0) return none;

  const progress = Math.min(100, player.realmProgress + raw);
  const gained = progress - player.realmProgress;
  // 产出 gained 点进度所需的最少时间片（不会超过 ticks）
  const ticksUsed = Math.min(ticks, Math.ceil(gained / perTick - 1e-9));
  const changes: StateChange[] = [{ stat: 'realmProgress', delta: gained }];

  let neili = player.neili;
  if (neili && realmHasNeili(player.realm)) {
    const gain = Math.min(neili.max - neili.current, Math.floor(ticksUsed * IDLE_CULTIVATION.neiliPerTick * coef * efficiency + 1e-9));
    neili = { ...neili, current: neili.current + gain };
    changes.push({ stat: 'neili', delta: gain });
  }
  return {
    player: { ...player, realmProgress: progress, neili },
    changes: changes.filter((c) => c.delta !== 0),
    ticksUsed,
    completed: progress >= 100,
  };
}
