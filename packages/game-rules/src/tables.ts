import type { Grade, Realm } from '@jhz/contracts';

/**
 * 规则数据表（占位基线，可随平衡调整；改动须同步测试与 docs/rules.md）。
 * 规则函数只读这些表，不在代码里散落魔法数字。
 */

/** 功法评级的经验系数 */
export const METHOD_EXP_COEFFICIENT: Record<Grade, number> = { fan: 1.0, huang: 1.5, xuan: 2.2, di: 3.2, tian: 4.5 };

/** 突破丹药按评级提供的成功率加成（百分点） */
export const PILL_BONUS_PERCENT: Record<Grade, number> = { fan: 10, huang: 20, xuan: 30, di: 40, tian: 50 };

/** 三种货币的兑换比例：1 元宝 = 100 银两，1 银两 = 1000 铜钱 */
export const CURRENCY = { silverPerYuanbao: 100, copperPerSilver: 1000 } as const;

/** 各境界突破到下一境界的参数；键为「当前境界」 */
export const BREAKTHROUGH: Record<Exclude<Realm, 'land_immortal'>, { next: Realm; basePercent: number; requiredScore: number }> = {
  body_tempering: { next: 'opening', basePercent: 70, requiredScore: 5 },
  opening: { next: 'houtian', basePercent: 50, requiredScore: 10 },
  houtian: { next: 'xiantian', basePercent: 35, requiredScore: 20 },
  xiantian: { next: 'grandmaster', basePercent: 20, requiredScore: 40 },
  grandmaster: { next: 'mingshen', basePercent: 10, requiredScore: 80 },
  mingshen: { next: 'land_immortal', basePercent: 5, requiredScore: 160 },
};

export const BREAKTHROUGH_RULES = {
  /** 综合分权重：根骨、悟性、神（精神值） */
  weights: { constitution: 0.4, comprehension: 0.4, spirit: 0.2 },
  /** 综合分每高于要求 1 分，成功率增加的百分点 */
  percentPerScore: 2,
  minPercent: 5,
  maxPercent: 95,
  /** 失败后的冷却：24 游戏小时（游戏分钟，从尝试结束时起算） */
  cooldownMinutes: 24 * 60,
  /** 失败损失：进度回落点数、气血上限比例（不会掉境界，也不会致死） */
  failureProgressLoss: 20,
  failureHpLossRatio: 0.2,
} as const;

/** 每次晋级的成长 */
export const REALM_ADVANCE = {
  maxHpGain: 30,
  maxStaminaGain: 5,
  /** 首次获得内力（突破到后天）时的内力上限，之后每次晋级增加 neiliGainPerRealm */
  firstNeiliMax: 60,
  neiliGainPerRealm: 60,
} as const;

/** 魅力（隐藏属性）：由称号中的外貌评价分（0–100）换算，每 10 分 1 点，0–10；未登记的称号按 50 分 */
export const APPEARANCE_SCORE_BY_EPITHET: Record<string, number> = {
  epithet_newcomer: 50,
};
export const DEFAULT_APPEARANCE_SCORE = 50;

/** 放置修炼：按固定时间片结算（1 片 = 1 分钟）；凡阶 12 进度/小时，约 8 小时圆满 */
export const IDLE_CULTIVATION = {
  tickMs: 60_000,
  progressPerTick: 0.2,
  neiliPerTick: 0.5,
  /** 每个时间片推进的游戏分钟：现实 1 分钟 = 游戏 2 分钟（1 小时 = 1 时辰） */
  gameMinutesPerTick: 2,
} as const;

/**
 * 离线收益：距上次接触（打开页面、结算、开始/停止）超过 thresholdMs 视为离线。
 * 离线结算单次最多计入 capMs，且只按 efficiency 的效率；在线（含页面每 30 秒的自动结算）全额。
 */
export const OFFLINE = {
  thresholdMs: 5 * 60_000,
  capMs: 12 * 60 * 60_000,
  efficiency: 0.5,
} as const;
