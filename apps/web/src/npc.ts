import type { QuestStatus, QuestView, RelationValues } from '@jhz/contracts';

/** 把三项关系数值概括为一句话（只是展示用的措辞，规则不依赖它） */
export function attitudeText(r: RelationValues): string {
  if (r.hostility >= 50) return '敌视';
  if (r.affinity >= 60) return '亲近';
  if (r.affinity >= 10) return '友善';
  if (r.affinity > -10) return '平淡';
  if (r.affinity > -40) return '冷淡';
  return '厌恶';
}

const NAMES: [keyof RelationValues, string][] = [
  ['affinity', '好感'],
  ['trust', '信任'],
  ['hostility', '敌意'],
];

/** 增减量的文字：「好感 +3 · 信任 +2」；全为 0 返回「无变化」 */
export function deltaText(d: RelationValues): string {
  const parts = NAMES.filter(([k]) => d[k] !== 0).map(([k, label]) => `${label} ${d[k] > 0 ? '+' : '−'}${Math.abs(d[k])}`);
  return parts.length > 0 ? parts.join(' · ') : '无变化';
}

/** 好感条：中点为 0，向右为正、向左为负；返回 left 与 width（百分比，0..100） */
export function affinityBar(v: number): { left: number; width: number } {
  const c = Math.max(-100, Math.min(100, v));
  return c >= 0 ? { left: 50, width: c / 2 } : { left: 50 + c / 2, width: -c / 2 };
}

export const QUEST_STATUS_LABEL: Record<QuestStatus, string> = {
  locked: '未解锁',
  available: '可接取',
  active: '进行中',
  completed: '已完成',
  failed: '已失败',
};

export const questStatusLabel = (q: Pick<QuestView, 'status' | 'claimed'>): string => (q.status === 'completed' && q.claimed ? '已领取' : QUEST_STATUS_LABEL[q.status]);

/** 左侧图标栏「任务」上的红点：有可接取的任务，或有已完成但没领奖励的任务 */
export const questNeedsAttention = (qs: readonly QuestView[]): boolean => qs.some((q) => q.status === 'available' || (q.status === 'completed' && !q.claimed));

/** 进行中的任务当前该做哪一步（第一个没完成的）；其他状态返回 -1 */
export const currentStep = (q: Pick<QuestView, 'status' | 'steps'>): number => (q.status === 'active' ? q.steps.findIndex((s) => !s.done) : -1);
