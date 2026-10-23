import type { ChangeStat, StateChange } from '@jhz/contracts';

const LABEL: Record<ChangeStat, string> = { stamina: '体力', hp: '气血', neili: '内力', realmProgress: '经验' };

export interface LogChip {
  text: string;
  tone: 'up' | 'down';
}

/** 把服务端返回的数值变化格式化为日志标签 */
export function formatChanges(changes: StateChange[]): LogChip[] {
  return changes
    .filter((c) => c.delta !== 0)
    .map((c) => {
      const unit = c.stat === 'realmProgress' ? '%' : '';
      const sign = c.delta > 0 ? '+' : '−';
      return { text: `${LABEL[c.stat]} ${sign}${Math.abs(c.delta)}${unit}`, tone: c.delta > 0 ? 'up' : 'down' };
    });
}
