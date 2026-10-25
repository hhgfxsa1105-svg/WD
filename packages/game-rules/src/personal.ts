import {
  PersonalProposalSchema,
  type Attributes,
  type PersonalDifficulty,
  type PersonalEffect,
  type PersonalProposal,
  type PersonalTier,
} from '@jhz/contracts';
import { isFactionId } from './factions.js';
import { NUMBERISH, SYSTEM_LIKE } from './narrative.js';
import { NPC_DEFS, isLocationId, isNpcId } from './world.js';

/**
 * 个人轨规则（纯函数）。AI 只能提议事件；耗时、体力、成功率、什么效果允许，全部由这里的表决定。
 */

/** 档位 → 耗时（游戏分钟）与体力。AI 只选档位，不能给数 */
export const PERSONAL_TIER_COST: Record<PersonalTier, { minutes: number; stamina: number }> = {
  small: { minutes: 30, stamina: 5 },
  medium: { minutes: 60, stamina: 10 },
  large: { minutes: 120, stamina: 20 },
};

/** 难度 → 基础成功率与「达标属性」。成功率 = 基础 + (属性 − 达标) × 每点加成，夹在 [min, max] */
export const PERSONAL_DIFFICULTY: Record<PersonalDifficulty, { base: number; need: number }> = {
  easy: { base: 75, need: 4 },
  normal: { base: 55, need: 6 },
  hard: { base: 35, need: 9 },
};
export const PERSONAL_CHANCE = { perPoint: 3, min: 10, max: 90 } as const;

/** 提议超过这么久没处理就作废（游戏分钟），算失败 */
export const PERSONAL_EXPIRE_MINUTES = 240;
/** 成功 / 失败分支里的地点封锁持续多久后自动恢复（游戏分钟） */
export const PERSONAL_LOCK_MINUTES = 1440;
/** 个人事件只允许临时封锁这些死胡同地点（封锁不会让玩家寸步难行） */
export const PERSONAL_BLOCKABLE_LOCATIONS = ['loc_qingyun_library', 'loc_qingyun_hall', 'loc_foot_town'] as const;

/** 成功率（百分点，整数）。纯函数：同样的属性与难度永远得到同样的结果 */
export function personalChance(difficulty: PersonalDifficulty, attributes: Attributes, skill: keyof Attributes): number {
  const d = PERSONAL_DIFFICULTY[difficulty];
  const raw = d.base + (attributes[skill] - d.need) * PERSONAL_CHANCE.perPoint;
  return Math.max(PERSONAL_CHANCE.min, Math.min(PERSONAL_CHANCE.max, Math.round(raw)));
}

/** 掷点 roll ∈ [0, 100) < 成功率 即成功 */
export const personalSucceeds = (roll: number, chancePercent: number): boolean => roll < chancePercent;

/** 展示用文字（标题、开场、叙述、传闻）的检查：不能带数字 / 货币 / 系统口吻 / 格式标记 / 链接 */
export function vetPersonalText(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const t = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (NUMBERISH.test(t) || SYSTEM_LIKE.test(t)) return null;
  return t;
}

export type ProposalRejection = 'NOT_JSON' | 'BAD_SHAPE' | 'BAD_TEXT' | 'BAD_EFFECT';
export type ProposalParse = { ok: true; proposal: PersonalProposal } | { ok: false; reason: ProposalRejection };

/** 把模型原文解析成提议：只接受一个 JSON 对象（可带代码围栏），严格校验结构、文字与效果。永不抛出 */
export function parsePersonalProposal(raw: string): ProposalParse {
  const text = String(raw ?? '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'NOT_JSON' };
  }
  const r = PersonalProposalSchema.safeParse(json);
  if (!r.success) return { ok: false, reason: 'BAD_SHAPE' };
  const p = r.data;
  const clean = (s: string) => vetPersonalText(s);
  const title = clean(p.title);
  const intro = clean(p.intro);
  const sOk = clean(p.success.narrative);
  const fOk = clean(p.failure.narrative);
  if (!title || !intro || !sOk || !fOk) return { ok: false, reason: 'BAD_TEXT' };
  const fix = (effects: PersonalEffect[]): PersonalEffect[] | null => {
    const out: PersonalEffect[] = [];
    for (const e of effects) {
      if (e.kind === 'rumor') {
        const t = clean(e.text);
        if (!t) return null;
        out.push({ ...e, text: t });
      } else if (e.kind === 'location_block') {
        const t = clean(e.reason);
        if (!t) return null;
        out.push({ ...e, reason: t });
      } else out.push(e);
    }
    return out;
  };
  const se = fix(p.success.effects);
  const fe = fix(p.failure.effects);
  if (!se || !fe) return { ok: false, reason: 'BAD_TEXT' };
  const proposal: PersonalProposal = { ...p, title, intro, success: { narrative: sOk, effects: se }, failure: { narrative: fOk, effects: fe } };
  return validateEffects(proposal) ? { ok: false, reason: 'BAD_EFFECT' } : { ok: true, proposal };
}

/** 效果必须指向真实存在的对象；不合格返回原因（null = 合格）。不看当前世界状态，那一步在应用时再判 */
export function validateEffects(p: PersonalProposal): string | null {
  for (const e of [...p.success.effects, ...p.failure.effects]) {
    switch (e.kind) {
      case 'npc_move':
        if (!isNpcId(e.npcId) || !isLocationId(e.locationId)) return `未知的人物或地点：${e.npcId} → ${e.locationId}`;
        break;
      case 'npc_status':
      case 'npc_attitude':
        if (!isNpcId(e.npcId)) return `未知的人物：${e.npcId}`;
        if (e.kind === 'npc_attitude' && !e.affinity && !e.trust && !e.hostility) return '态度效果没有任何变化';
        break;
      case 'location_block':
        if (!(PERSONAL_BLOCKABLE_LOCATIONS as readonly string[]).includes(e.locationId)) return `不允许临时封锁：${e.locationId}`;
        break;
      case 'faction_strength':
      case 'faction_attitude':
        if (!isFactionId(e.factionId)) return `未知的势力：${e.factionId}`;
        break;
      case 'faction_relation':
        if (!isFactionId(e.a) || !isFactionId(e.b) || e.a === e.b) return `未知的势力关系：${e.a} / ${e.b}`;
        break;
      case 'rumor':
        break;
    }
  }
  return null;
}

/** 玩家看到的难度与档位说法 */
export const TIER_LABEL: Record<PersonalTier, string> = { small: '小事', medium: '一桩事', large: '大事' };
export const DIFFICULTY_LABEL: Record<PersonalDifficulty, string> = { easy: '不难', normal: '寻常', hard: '棘手' };

/** 提议里涉及的人物显示名（给界面和日志用） */
export const npcName = (id: string): string => (isNpcId(id) ? NPC_DEFS[id].name : id);
