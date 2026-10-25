import type { LogRecord } from '@jhz/contracts';
import { INITIAL_GAME_MINUTES, gameDate } from '@jhz/game-rules';
import { formatChanges, type LogChip } from './changes';
import { REALM_LABEL } from './labels';
import { offlineSummary } from './offline';

export interface LogEntry {
  /** 稳定的唯一键：服务端日志序号，或序号加后缀（同一条记录派生的附加条目） */
  key: string;
  /** 服务端日志序号；欢迎语为 0 */
  seq: number;
  /** 时辰，如「巳时」；旧记录没有游戏时间则为空 */
  time: string;
  /** 完整的游戏时间，如「第 3 天 · 巳时」，作为悬停提示 */
  timeTitle?: string;
  text: string;
  chips: LogChip[];
  /** 小字补充，如「成功率 · 掷点」「放置修炼 · 结算 N 分钟」 */
  sub?: string;
  system?: boolean;
  /** 叙事待补：结算已生效，文字为模板；可对该行动重试叙事 */
  pendingNarration?: { actionId: string };
}

/** 日志旁的时间标记：取自事件发生时的游戏时间（不是现实时间，也不是序号） */
export function timeOf(gameMinutes: number | null): { time: string; timeTitle?: string } {
  if (gameMinutes === null) return { time: '' };
  const d = gameDate(gameMinutes);
  return { time: `${d.shichen}时`, timeTitle: d.label };
}

export const WELCOME: LogEntry = {
  key: 'welcome',
  seq: 0,
  ...timeOf(INITIAL_GAME_MINUTES),
  text: '你醒来时，天光尚淡。远处山门钟声一响，今日的江湖便开始了。',
  chips: [],
  system: true,
};

const FULL_NOTE_TEXT = '周身真气盈满，似乎触到了一道无形的关隘。';

/** 把服务端的结构化日志记录渲染为界面条目；一条记录可能派生出附加条目（如「修炼已圆满」） */
export function toLogEntries(r: LogRecord): LogEntry[] {
  const base: Pick<LogEntry, 'key' | 'seq' | 'time' | 'timeTitle' | 'pendingNarration'> = { key: String(r.id), seq: r.id, ...timeOf(r.gameMinutes) };
  if (r.narration?.pending) base.pendingNarration = { actionId: r.narration.actionId };

  if (r.type === 'breakthrough' && r.breakthrough) {
    const b = r.breakthrough;
    // 成功时进度清零不当作「经验 −100%」展示，改为境界变化标签
    const changes = formatChanges(r.changes.filter((c) => !(b.outcome === 'success' && c.stat === 'realmProgress')));
    const chips: LogChip[] =
      b.outcome === 'success' ? [{ text: `境界 ${REALM_LABEL[b.realmFrom]}→${REALM_LABEL[b.realmTo]}`, tone: 'up' }, ...changes] : changes;
    const sub = [
      `成功率 ${b.chancePercent}% · 掷点 ${b.roll.toFixed(2)}`,
      b.pillName ? `消耗${b.pillName} ×1` : null,
      b.outcome === 'failure' ? '冷却 24 游戏小时' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return [{ ...base, text: r.narrative, chips, sub }];
  }

  if (r.type === 'idle' && r.idle) {
    const offline = r.idle.offline ? offlineSummary(r.idle.offline) : null;
    const gained = r.changes.length > 0;
    const sub = gained
      ? [`放置修炼 · 结算 ${r.idle.ticks} 分钟`, offline].filter(Boolean).join(' · ')
      : `${offline ?? '放置修炼'} · 收益不足 1% 经验`;
    const entries: LogEntry[] = [{ ...base, text: r.narrative, chips: formatChanges(r.changes), sub }];
    if (r.note) entries.push({ ...base, key: `${r.id}-note`, text: FULL_NOTE_TEXT, chips: [], sub: r.note, system: true });
    return entries;
  }

  if (r.type === 'system') return [{ ...base, text: r.narrative, chips: formatChanges(r.changes), sub: r.note ?? undefined, system: true }];

  return [{ ...base, text: r.narrative, chips: formatChanges(r.changes) }];
}

/** 合并新条目：按 key 去重（幂等重试回放同一条记录时不会重复显示），并保持序号顺序 */
export function mergeEntries(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const seen = new Set(current.map((e) => e.key));
  const fresh = incoming.filter((e) => !seen.has(e.key));
  return fresh.length === 0 ? current : [...current, ...fresh].sort((a, b) => a.seq - b.seq);
}

/** 用新内容替换同一个 key 的条目（叙事重试成功后文字变了）；没有对应条目则忽略 */
export function replaceEntries(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const byKey = new Map(incoming.map((e) => [e.key, e]));
  return current.map((e) => byKey.get(e.key) ?? e);
}
