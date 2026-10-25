import {
  realmHasNeili,
  type Attributes,
  type Grade,
  type PlayerState,
  type Realm,
  type StateChange,
} from '@jhz/contracts';
import type { Rng } from './rng.js';
import { BREAKTHROUGH, BREAKTHROUGH_RULES, PILL_BONUS_PERCENT, REALM_ADVANCE } from './tables.js';

const round1 = (n: number): number => Math.round(n * 10) / 10;

export const nextRealm = (realm: Realm): Realm | null => (realm === 'land_immortal' ? null : BREAKTHROUGH[realm].next);

/** 综合分 = 根骨×40% + 悟性×40% + 神×20% */
export function attributeScore(a: Pick<Attributes, 'constitution' | 'comprehension' | 'spirit'>): number {
  const w = BREAKTHROUGH_RULES.weights;
  return a.constitution * w.constitution + a.comprehension * w.comprehension + a.spirit * w.spirit;
}

export interface ChanceBreakdown {
  base: number;
  attributeBonus: number;
  pillBonus: number;
  /** 最终成功率（百分比，限制在 minPercent–maxPercent，保留 1 位小数） */
  percent: number;
}

/** 突破成功率；已是最高境界时返回 null */
export function breakthroughChance(
  p: Pick<PlayerState, 'realm' | 'attributes'>,
  pillGrade: Grade | null = null,
): ChanceBreakdown | null {
  if (p.realm === 'land_immortal') return null;
  const row = BREAKTHROUGH[p.realm];
  const attributeBonus = round1((attributeScore(p.attributes) - row.requiredScore) * BREAKTHROUGH_RULES.percentPerScore);
  const pillBonus = pillGrade ? PILL_BONUS_PERCENT[pillGrade] : 0;
  const raw = row.basePercent + attributeBonus + pillBonus;
  const percent = round1(Math.min(BREAKTHROUGH_RULES.maxPercent, Math.max(BREAKTHROUGH_RULES.minPercent, raw)));
  return { base: row.basePercent, attributeBonus, pillBonus, percent };
}

export type BreakthroughResolution =
  | {
      ok: true;
      outcome: 'success' | 'failure';
      /** 本次使用的成功率与掷点（0–100），便于审计与复现 */
      chancePercent: number;
      roll: number;
      player: PlayerState;
      changes: StateChange[];
      narrative: string;
    }
  | { ok: false; code: 'MAX_REALM' | 'PROGRESS_NOT_FULL' | 'COOLDOWN'; message: string; availableAt?: number };

const nonZero = (c: StateChange[]) => c.filter((x) => x.delta !== 0);

/**
 * 突破结算（纯函数）。前置：已是最高境界 / 进度未满 / 冷却中 均拒绝且无副作用。
 * 成功：晋级、进度清零、气血与体力上限提升，首次到达后天获得内力，清除冷却。
 * 失败：进度回落、气血受损（至少保留 1 点），进入冷却；丹药不论成败都已消耗（由调用方扣减库存）。
 */
export function resolveBreakthrough(
  player: PlayerState,
  /** now：当前游戏分钟；elapsed：这次尝试本身耗时（游戏分钟），失败冷却从尝试结束时起算 */
  opts: { now: number; rng: Rng; pillGrade?: Grade | null; elapsed?: number },
): BreakthroughResolution {
  const target = nextRealm(player.realm);
  if (!target) return { ok: false, code: 'MAX_REALM', message: '你已臻陆地神仙，再无更高境界' };
  if (player.realmProgress < 100) return { ok: false, code: 'PROGRESS_NOT_FULL', message: '修炼进度未满，尚不能突破' };
  if (player.breakthroughAvailableAt !== null && opts.now < player.breakthroughAvailableAt) {
    return {
      ok: false,
      code: 'COOLDOWN',
      message: '上次突破失败，气息未平，需隔一日再试',
      availableAt: player.breakthroughAvailableAt,
    };
  }

  const chance = breakthroughChance(player, opts.pillGrade ?? null)!;
  const roll = Math.floor(opts.rng() * 10000) / 100; // 两位小数，范围 [0, 99.99]
  const success = roll < chance.percent;

  if (success) {
    let neili = player.neili;
    if (realmHasNeili(target)) {
      neili = neili
        ? { ...neili, max: neili.max + REALM_ADVANCE.neiliGainPerRealm }
        : { current: 0, max: REALM_ADVANCE.firstNeiliMax };
    }
    const next: PlayerState = {
      ...player,
      realm: target,
      realmProgress: 0,
      maxHp: player.maxHp + REALM_ADVANCE.maxHpGain,
      maxStamina: player.maxStamina + REALM_ADVANCE.maxStaminaGain,
      neili,
      breakthroughAvailableAt: null,
    };
    return {
      ok: true,
      outcome: 'success',
      chancePercent: chance.percent,
      roll,
      player: next,
      changes: nonZero([
        { stat: 'realmProgress', delta: -player.realmProgress },
        { stat: 'maxHp', delta: REALM_ADVANCE.maxHpGain },
        { stat: 'maxStamina', delta: REALM_ADVANCE.maxStaminaGain },
      ]),
      narrative: `真气冲关，豁然贯通，你的修为迈入了新的境界。`,
    };
  }

  const hpLoss = Math.min(player.hp - 1, Math.floor(player.maxHp * BREAKTHROUGH_RULES.failureHpLossRatio));
  const progress = Math.max(0, player.realmProgress - BREAKTHROUGH_RULES.failureProgressLoss);
  const hp = player.hp - Math.max(0, hpLoss);
  return {
    ok: true,
    outcome: 'failure',
    chancePercent: chance.percent,
    roll,
    player: { ...player, realmProgress: progress, hp, breakthroughAvailableAt: opts.now + (opts.elapsed ?? 0) + BREAKTHROUGH_RULES.cooldownMinutes },
    changes: nonZero([
      { stat: 'realmProgress', delta: progress - player.realmProgress },
      { stat: 'hp', delta: hp - player.hp },
    ]),
    narrative: '真气冲关受阻，经脉一阵剧痛，你只得收功调息，改日再试。',
  };
}
