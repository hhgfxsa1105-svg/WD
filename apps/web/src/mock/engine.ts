import { PlayerStateSchema, realmHasNeili, type PlayerState } from '@jhz/contracts';
import type { LogChip } from './data';

export interface ActionResult {
  player: PlayerState;
  text: string;
  chips: LogChip[];
}

const CULTIVATE_COST = 10;
const CULTIVATE_PROGRESS = 4;
const CULTIVATE_NEILI = 6;
const REST_STAMINA = 15;
const REST_HP = 5;

/** 本地示例结算；T-007/T-008 起由服务端规则替换。返回 null 表示条件不满足。 */
export function cultivate(p: PlayerState): ActionResult | null {
  if (p.stamina < CULTIVATE_COST) return null;
  const chips: LogChip[] = [
    { text: `体力 −${CULTIVATE_COST}`, tone: 'down' },
    { text: `经验 +${CULTIVATE_PROGRESS}%`, tone: 'up' },
  ];
  let neili = p.neili;
  if (neili && realmHasNeili(p.realm)) {
    const gain = Math.min(CULTIVATE_NEILI, neili.max - neili.current);
    neili = { ...neili, current: neili.current + gain };
    chips.push({ text: `内力 +${gain}`, tone: 'up' });
  }
  const player = PlayerStateSchema.parse({
    ...p,
    stamina: p.stamina - CULTIVATE_COST,
    realmProgress: Math.min(100, p.realmProgress + CULTIVATE_PROGRESS),
    neili,
    version: p.version + 1,
  });
  return { player, text: '你盘膝而坐，运转功法，一周天下来，只觉经脉微微发热。', chips };
}

export function rest(p: PlayerState): ActionResult {
  const stamina = Math.min(p.maxStamina, p.stamina + REST_STAMINA);
  const hp = Math.min(p.maxHp, p.hp + REST_HP);
  const player = PlayerStateSchema.parse({ ...p, stamina, hp, version: p.version + 1 });
  return {
    player,
    text: '你在檐下歇了一阵，山风拂过，倦意渐消。',
    chips: [
      { text: `体力 +${stamina - p.stamina}`, tone: 'up' },
      { text: `气血 +${hp - p.hp}`, tone: 'up' },
    ],
  };
}

export const COSTS = { CULTIVATE_COST, CULTIVATE_PROGRESS, CULTIVATE_NEILI, REST_STAMINA, REST_HP };
