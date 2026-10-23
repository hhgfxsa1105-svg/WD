import type { Grade } from '@jhz/contracts';
import { METHOD_EXP_COEFFICIENT } from './tables.js';

/**
 * 一次修炼获得的进度点数 = round(基础 × 功法评级系数 × (100 + 加成%) / 100)。
 * 加成来自名号等；进度总量封顶由调用方处理。
 */
export function progressGain(input: { base: number; methodGrade: Grade; bonusPercent: number }): number {
  const bonus = Math.max(-90, input.bonusPercent);
  return Math.round((input.base * METHOD_EXP_COEFFICIENT[input.methodGrade] * (100 + bonus)) / 100);
}
