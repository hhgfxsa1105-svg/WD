import { moveCost } from './world.js';

/**
 * 游戏时钟（纯规则）：时间是整数「游戏分钟」，只由玩家行动和放置修炼推进，与现实时间无关。
 * 1 时辰 = 2 小时 = 120 分钟；1 天 = 12 时辰 = 1440 分钟。第 0 分钟 = 第 1 天 00:00。
 */
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_SHICHEN = 120;
export const MINUTES_PER_DAY = 1440;

/** 新游戏的起点：第 1 天辰时（07:00） */
export const INITIAL_GAME_MINUTES = 7 * MINUTES_PER_HOUR;

/** 单次推进的上限（防御）：放置修炼离线最多折算 24 游戏小时，留一倍余量 */
export const MAX_ADVANCE_MINUTES = 2 * MINUTES_PER_DAY;

/** 地支时辰；子时跨 23:00–01:00，其余每个时辰 2 小时 */
export const SHICHEN_NAMES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const;

export interface GameDate {
  /** 第几天，从 1 开始 */
  day: number;
  /** 时辰名，如「巳」 */
  shichen: (typeof SHICHEN_NAMES)[number];
  /** 当天的小时与分钟（0–23、0–59） */
  hour: number;
  minute: number;
  /** 展示用：「第 3 天 · 巳时」 */
  label: string;
}

export function gameDate(minutes: number): GameDate {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`游戏分钟必须是非负整数：${minutes}`);
  const day = Math.floor(minutes / MINUTES_PER_DAY) + 1;
  const inDay = minutes % MINUTES_PER_DAY;
  const hour = Math.floor(inDay / MINUTES_PER_HOUR);
  const shichen = SHICHEN_NAMES[Math.floor(((hour + 1) % 24) / 2)]!;
  return { day, shichen, hour, minute: inDay % MINUTES_PER_HOUR, label: `第 ${day} 天 · ${shichen}时` };
}

/** 行动耗时（游戏分钟）；移动按连线（见 LOCATION_LINKS），其余在此。 */
export const ACTION_MINUTES = {
  cultivate: 60,
  rest: 120,
  breakthrough: 180,
  /** 与人打招呼（仅第一次相识会产生变化与耗时） */
  greet: 10,
  /** 接取 / 领取 / 放弃任务 */
  quest: 10,
  /** 查看状态、澄清、被拒绝的行动：不耗时 */
  none: 0,
} as const;

/** 移动耗时；不相邻返回 null */
export const moveMinutes = (fromId: string, toId: string): number | null => moveCost(fromId, toId)?.minutes ?? null;

/** 放置修炼：消耗 N 个时间片折算的游戏分钟（现实 1 分钟 = 游戏 2 分钟，即 1 小时 = 1 时辰） */
export const idleGameMinutes = (ticks: number, gameMinutesPerTick: number): number => Math.max(0, Math.floor(ticks)) * gameMinutesPerTick;

/** 以游戏分钟表示的时长的中文描述：「18 小时」「1 天 6 小时」「45 分钟」 */
export function formatGameDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return '不足 1 分钟';
  const d = Math.floor(m / MINUTES_PER_DAY);
  const h = Math.floor((m % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const r = m % MINUTES_PER_HOUR;
  const parts = [d ? `${d} 天` : '', h ? `${h} 小时` : '', r && !d ? `${r} 分钟` : ''].filter(Boolean);
  return parts.join(' ');
}
