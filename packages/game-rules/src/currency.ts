import type { Currency } from '@jhz/contracts';
import { CURRENCY } from './tables.js';

const { silverPerYuanbao, copperPerSilver } = CURRENCY;
const COPPER_PER_YUANBAO = silverPerYuanbao * copperPerSilver;

/** 折合铜钱的总值 */
export const totalCopper = (c: Currency): number => c.yuanbao * COPPER_PER_YUANBAO + c.silver * copperPerSilver + c.copper;

export const canAfford = (c: Currency, copperCost: number): boolean => Number.isInteger(copperCost) && copperCost >= 0 && totalCopper(c) >= copperCost;

/**
 * 支付铜钱价格：优先用铜钱，不足再用银两，最后用元宝，多付部分以小面额找零。
 * 余额不足时返回 null。总价值守恒：支付前总值 = 支付后总值 + 价格。
 */
export function spend(c: Currency, copperCost: number): Currency | null {
  if (!canAfford(c, copperCost)) return null;
  let { yuanbao, silver, copper } = c;
  let rest = copperCost;

  const useCopper = Math.min(copper, rest);
  copper -= useCopper;
  rest -= useCopper;

  if (rest > 0) {
    const coins = Math.min(silver, Math.ceil(rest / copperPerSilver));
    silver -= coins;
    const paid = coins * copperPerSilver;
    const used = Math.min(paid, rest);
    rest -= used;
    copper += paid - used; // 找零
  }

  if (rest > 0) {
    const coins = Math.min(yuanbao, Math.ceil(rest / COPPER_PER_YUANBAO));
    yuanbao -= coins;
    const paid = coins * COPPER_PER_YUANBAO;
    const change = paid - Math.min(paid, rest);
    rest = 0;
    silver += Math.floor(change / copperPerSilver);
    copper += change % copperPerSilver;
  }

  return { yuanbao, silver, copper };
}

/** 获得铜钱（不自动合并面额，面额合并请用 exchange） */
export const earnCopper = (c: Currency, amount: number): Currency => ({ ...c, copper: c.copper + amount });

/** 兑换：把较大面额换成较小面额，或把小面额凑整换成大面额。余额不足返回 null。 */
export function exchange(c: Currency, from: keyof Currency, to: keyof Currency, count: number): Currency | null {
  if (!Number.isInteger(count) || count <= 0 || from === to) return null;
  const unit: Record<keyof Currency, number> = { yuanbao: COPPER_PER_YUANBAO, silver: copperPerSilver, copper: 1 };
  if (c[from] < count) return null;
  const value = count * unit[from];
  // 换成大面额时，只能换整数个目标面额，且不得损失价值
  if (unit[to] > unit[from] && value % unit[to] !== 0) return null;
  return { ...c, [from]: c[from] - count, [to]: c[to] + value / unit[to] };
}
