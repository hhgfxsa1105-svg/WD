import type { PlayerState } from '@jhz/contracts';
import { APPEARANCE_SCORE_BY_EPITHET, DEFAULT_APPEARANCE_SCORE } from './tables.js';

/** 外貌评价分（0–100）换算魅力：每 10 分 1 点，范围 0–10 */
export const charmFromAppearance = (score: number): number => Math.min(10, Math.max(0, Math.floor(score / 10)));

/** 隐藏属性魅力：由称号中的外貌评价决定，仅服务端使用，不进入契约 */
export function charmOf(p: Pick<PlayerState, 'epithet'>): number {
  const score = p.epithet ? (APPEARANCE_SCORE_BY_EPITHET[p.epithet.id] ?? DEFAULT_APPEARANCE_SCORE) : DEFAULT_APPEARANCE_SCORE;
  return charmFromAppearance(score);
}
