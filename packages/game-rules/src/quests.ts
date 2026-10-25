import { REALMS, type PlayerState, type QuestStatus, type Realm } from '@jhz/contracts';
import type { RelationDelta } from './world.js';

/**
 * 任务定义与规则（静态）。条件一律是「服务端能从已保存状态判定的事实」，玩家和 AI 都无法声明条件已满足。
 * 任务按步骤顺序推进；全部步骤完成后任务进入 completed，奖励需要玩家手动领取，且只能领取一次。
 */

export type QuestCondition =
  | { kind: 'met_npc'; npcId: string }
  | { kind: 'at_location'; locationId: string }
  | { kind: 'progress_at_least'; value: number }
  | { kind: 'realm_at_least'; realm: Realm };

export interface QuestStepDef {
  text: string;
  condition: QuestCondition;
}

export interface QuestReward {
  currency?: { yuanbao?: number; silver?: number; copper?: number };
  items?: { itemId: string; quantity: number }[];
}

export interface QuestDef {
  name: string;
  summary: string;
  /** 发布任务的人物（展示用） */
  giver: string | null;
  /** 前置任务；未完成时本任务处于 locked */
  requires: string | null;
  steps: readonly QuestStepDef[];
  reward: QuestReward;
  /** 领取奖励时 NPC 的反应：关系变化与一句话 */
  reaction: { npcId: string; relation: RelationDelta; text: string } | null;
}

const RAW_QUESTS = {
  quest_first_steps: {
    name: '初入山门',
    summary: '新弟子上山，先认认门，认认人。',
    giver: '赵铁牛',
    requires: null,
    steps: [
      { text: '与守门弟子赵铁牛相识', condition: { kind: 'met_npc', npcId: 'npc_gate_guard' } },
      { text: '前往练功场', condition: { kind: 'at_location', locationId: 'loc_qingyun_yard' } },
      { text: '与大师姐苏晚晴相识', condition: { kind: 'met_npc', npcId: 'npc_senior_sister' } },
    ],
    reward: { currency: { copper: 100 } },
    reaction: { npcId: 'npc_gate_guard', relation: { affinity: 3, trust: 3 }, text: '赵铁牛笑着拍了拍你的肩：「不错，这就算认门了。」' },
  },
  quest_prove_yourself: {
    name: '证明自己',
    summary: '大师姐想看看你有没有练功的资质。',
    giver: '苏晚晴',
    requires: 'quest_first_steps',
    steps: [
      { text: '修炼进度达到 50%', condition: { kind: 'progress_at_least', value: 50 } },
      { text: '突破到通窍境界', condition: { kind: 'realm_at_least', realm: 'opening' } },
    ],
    reward: { currency: { silver: 20 }, items: [{ itemId: 'pill_breakthrough_fan', quantity: 1 }] },
    reaction: { npcId: 'npc_senior_sister', relation: { affinity: 8, trust: 6 }, text: '苏晚晴点了点头：「没给青云山丢脸。」' },
  },
} as const satisfies Record<string, QuestDef>;
export type QuestId = keyof typeof RAW_QUESTS;
/** 对外暴露为宽类型（每个字段都是 QuestDef 声明的类型），键仍是具体的任务 ID */
export const QUEST_DEFS: Record<QuestId, QuestDef> = RAW_QUESTS;

export const isQuestId = (id: string): id is QuestId => Object.hasOwn(QUEST_DEFS, id);

/** 状态机允许的流转；completed 与 failed 是终态 */
export const QUEST_TRANSITIONS: Record<QuestStatus, readonly QuestStatus[]> = {
  locked: ['available'],
  available: ['active'],
  active: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export const canTransition = (from: QuestStatus, to: QuestStatus): boolean => QUEST_TRANSITIONS[from].includes(to);

/** 判定条件所需的事实（全部来自已保存状态） */
export interface QuestFacts {
  player: Pick<PlayerState, 'location' | 'realmProgress' | 'realm'>;
  /** 已与玩家相识的 NPC（按需查询，不必预先列出全部） */
  metNpcs: { has(npcId: string): boolean };
}

export function conditionMet(c: QuestCondition, f: QuestFacts): boolean {
  switch (c.kind) {
    case 'met_npc':
      return f.metNpcs.has(c.npcId);
    case 'at_location':
      return f.player.location.id === c.locationId;
    case 'progress_at_least':
      return f.player.realmProgress >= c.value;
    case 'realm_at_least':
      return REALMS.indexOf(f.player.realm) >= REALMS.indexOf(c.realm);
  }
}

/** 从已完成的步骤数起，按顺序推进到第一个未满足的步骤；返回新的已完成步骤数（只增不减） */
export function advanceSteps(def: Pick<QuestDef, 'steps'>, done: number, facts: QuestFacts): number {
  let i = Math.max(0, Math.min(done, def.steps.length));
  while (i < def.steps.length && conditionMet(def.steps[i]!.condition, facts)) i++;
  return i;
}

/** 奖励的展示文字 */
export function rewardLines(r: QuestReward, itemName: (id: string) => string): string[] {
  const c = r.currency ?? {};
  return [
    ...(c.yuanbao ? [`元宝 ${c.yuanbao}`] : []),
    ...(c.silver ? [`银两 ${c.silver}`] : []),
    ...(c.copper ? [`铜钱 ${c.copper}`] : []),
    ...(r.items ?? []).map((i) => `${itemName(i.itemId)} ×${i.quantity}`),
  ];
}

/** 初始状态：没有前置任务的为 available，其余为 locked */
export const initialQuestStatus = (id: QuestId): QuestStatus => (QUEST_DEFS[id].requires === null ? 'available' : 'locked');
