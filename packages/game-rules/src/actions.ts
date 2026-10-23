import {
  realmHasNeili,
  type FixedActionId,
  type PlayerState,
  type StateChange,
} from '@jhz/contracts';
import { progressGain } from './progress.js';

/** 数值为占位基线，S2（T-007）统一调整；所有结算为纯函数，不修改入参 */
export const RULES = {
  cultivate: { staminaCost: 10, baseProgress: 10, neiliGain: 6 },
  rest: { staminaGain: 15, hpGain: 5 },
} as const;

export type ActionResolution =
  | { ok: true; player: PlayerState; changes: StateChange[]; narrative: string }
  | { ok: false; code: 'INSUFFICIENT_STAMINA'; message: string };

/** 名号（头衔/称号/命格）提供的修炼经验加成，单位为百分点；下限 −90 */
export function expBonusPercent(p: PlayerState): number {
  const total = [p.title, p.epithet, p.fate]
    .flatMap((h) => h?.effects ?? [])
    .filter((e) => e.kind === 'exp_multiplier')
    .reduce((sum, e) => sum + e.value, 0);
  return Math.max(-90, total);
}

const nonZero = (changes: StateChange[]) => changes.filter((c) => c.delta !== 0);

function cultivate(p: PlayerState): ActionResolution {
  const { staminaCost, baseProgress, neiliGain } = RULES.cultivate;
  if (p.stamina < staminaCost) {
    return { ok: false, code: 'INSUFFICIENT_STAMINA', message: `体力不足，修炼需要 ${staminaCost} 点体力` };
  }
  // 功法系统（S2 后续）接入前，统一按凡阶基础吐纳法结算
  const gainedProgress = progressGain({ base: baseProgress, methodGrade: 'fan', bonusPercent: expBonusPercent(p) });
  const progress = Math.min(100, p.realmProgress + gainedProgress);
  const changes: StateChange[] = [
    { stat: 'stamina', delta: -staminaCost },
    { stat: 'realmProgress', delta: progress - p.realmProgress },
  ];
  let neili = p.neili;
  if (neili && realmHasNeili(p.realm)) {
    const gain = Math.min(neiliGain, neili.max - neili.current);
    neili = { ...neili, current: neili.current + gain };
    changes.push({ stat: 'neili', delta: gain });
  }
  return {
    ok: true,
    player: { ...p, stamina: p.stamina - staminaCost, realmProgress: progress, neili },
    changes: nonZero(changes),
    narrative: '你盘膝而坐，运转功法，一周天下来，只觉经脉微微发热。',
  };
}

function rest(p: PlayerState): ActionResolution {
  const stamina = Math.min(p.maxStamina, p.stamina + RULES.rest.staminaGain);
  const hp = Math.min(p.maxHp, p.hp + RULES.rest.hpGain);
  return {
    ok: true,
    player: { ...p, stamina, hp },
    changes: nonZero([
      { stat: 'stamina', delta: stamina - p.stamina },
      { stat: 'hp', delta: hp - p.hp },
    ]),
    narrative: '你在檐下歇了一阵，山风拂过，倦意渐消。',
  };
}

/** 固定行动结算：返回新状态与变化摘要；条件不满足时返回 ok:false，且不产生任何变化 */
export function resolveFixedAction(player: PlayerState, actionId: FixedActionId): ActionResolution {
  return actionId === 'cultivate' ? cultivate(player) : rest(player);
}
