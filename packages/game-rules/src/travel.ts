import type { PlayerState, StateChange } from '@jhz/contracts';
import { LOCATION_DEFS, isLocationId, moveCost } from './world.js';

export type MoveResolution =
  | { ok: true; player: PlayerState; changes: StateChange[]; narrative: string; /** 这一步的游戏耗时（分钟），由游戏时钟推进 */ minutes: number }
  | { ok: false; code: 'UNKNOWN_LOCATION' | 'ALREADY_THERE' | 'NOT_ADJACENT' | 'BLOCKED' | 'INSUFFICIENT_STAMINA'; message: string };

/**
 * 前往相邻地点：纯函数，不修改入参。地点必须存在、与当前所在地相连、没有被封锁、体力足够。
 * blockedReason：返回目的地被封锁的原因（没有封锁返回 null/undefined）；离开被封锁的地方不受限制。
 */
export function resolveMove(player: PlayerState, toId: string, blockedReason?: (locationId: string) => string | null | undefined): MoveResolution {
  if (!isLocationId(toId)) return { ok: false, code: 'UNKNOWN_LOCATION', message: '没有这个地方' };
  if (toId === player.location.id) return { ok: false, code: 'ALREADY_THERE', message: '你已经在这里了' };
  const cost = moveCost(player.location.id, toId);
  if (!cost) return { ok: false, code: 'NOT_ADJACENT', message: '那里不在附近，需要先走到相邻的地方' };
  const blocked = blockedReason?.(toId);
  if (blocked) return { ok: false, code: 'BLOCKED', message: `过不去：${blocked}` };
  if (player.stamina < cost.stamina) return { ok: false, code: 'INSUFFICIENT_STAMINA', message: '体力不足，先休息一下再赶路' };
  const to = LOCATION_DEFS[toId];
  return {
    ok: true,
    player: { ...player, stamina: player.stamina - cost.stamina, location: { id: toId, name: to.name } },
    changes: [{ stat: 'stamina', delta: -cost.stamina }],
    narrative: `你离开${player.location.name}，前往${to.name}。`,
    minutes: cost.minutes,
  };
}
