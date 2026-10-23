import type { LogChip } from './changes';

export interface LogEntry {
  id: number;
  time: string;
  text: string;
  chips: LogChip[];
  system?: boolean;
}

const HOURS = ['辰时', '巳时', '午时', '未时', '申时', '酉时'];
export const hourLabel = (n: number): string => HOURS[Math.min(n, HOURS.length - 1)] ?? '辰时';

export const INITIAL_LOG: LogEntry[] = [
  { id: 0, time: hourLabel(0), text: '你醒来时，天光尚淡。远处山门钟声一响，今日的江湖便开始了。', chips: [], system: true },
];
