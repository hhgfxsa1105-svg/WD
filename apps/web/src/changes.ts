import type { ChangeStat } from '@jhz/contracts';

const LABEL: Record<ChangeStat, string> = {
  stamina: '体力',
  hp: '气血',
  neili: '内力',
  realmProgress: '经验',
  maxHp: '气血上限',
  maxStamina: '体力上限',
  yuanbao: '元宝',
  silver: '银两',
  copper: '铜钱',
};

export interface LogChip {
  text: string;
  tone: 'up' | 'down';
}

/** 把服务端返回的数值变化格式化为日志标签；0 与未知项目不显示 */
export function formatChanges(changes: { stat: string; delta: number }[]): LogChip[] {
  return changes
    .filter((c) => c.delta !== 0 && c.stat in LABEL)
    .map((c) => {
      const unit = c.stat === 'realmProgress' ? '%' : '';
      const sign = c.delta > 0 ? '+' : '−';
      return { text: `${LABEL[c.stat as ChangeStat]} ${sign}${Math.abs(c.delta)}${unit}`, tone: c.delta > 0 ? 'up' : 'down' };
    });
}
