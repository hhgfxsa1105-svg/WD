import type { PlayerState, StateChange } from '@jhz/contracts';
import { LOCATION_DEFS, MOVE_STAMINA_COST, areAdjacent, isLocationId } from './world.js';

export type MoveResolution =
  | { ok: true; player: PlayerState; changes: StateChange[]; narrative: string }
  | { ok: false; code: 'UNKNOWN_LOCATION' | 'ALREADY_THERE' | 'NOT_ADJACENT' | 'INSUFFICIENT_STAMINA'; message: string };

/** 前往相邻地点：纯函数，不修改入参。地点必须存在、与当前所在地相连、体力足够 */
export function resolveMove(player: PlayerState, toId: string): MoveResolution {
  if (!isLocationId(toId)) return { ok: false, code: 'UNKNOWN_LOCATION', message: '没有这个地方' };
  if (toId === player.location.id) return { ok: false, code: 'ALREADY_THERE', message: '你已经在这里了' };
  if (!areAdjacent(player.location.id, toId)) return { ok: false, code: 'NOT_ADJACENT', message: '那里不在附近，需要先走到相邻的地方' };
  if (player.stamina < MOVE_STAMINA_COST) return { ok: false, code: 'INSUFFICIENT_STAMINA', message: '体力不足，先休息一下再赶路' };
  const to = LOCATION_DEFS[toId];
  return {
    ok: true,
    player: { ...player, stamina: player.stamina - MOVE_STAMINA_COST, location: { id: toId, name: to.name } },
    changes: [{ stat: 'stamina', delta: -MOVE_STAMINA_COST }],
    narrative: `你离开${player.location.name}，沿山道来到${to.name}。`,
  };
}
