/**
 * 势力（静态定义 + 纯规则）。势力的实力、对玩家的态度和势力之间的关系只能被程序定义的事件小幅改动，
 * AI 不能直接写。每个事件对每项的单次改动不超过 MAX_FACTION_DELTA。
 */
export const FACTION_DEFS = {
  fac_qingyun: { name: '青云派', summary: '青云山上的正道门派，门风端方，弟子不多。', strength: 60, attitude: 10 },
  fac_blackwind: { name: '黑风寨', summary: '盘踞在山下的山寨，常在山道上拦路收钱。', strength: 40, attitude: 0 },
} as const satisfies Record<string, { name: string; summary: string; strength: number; attitude: number }>;
export type FactionId = keyof typeof FACTION_DEFS;
export const FACTION_IDS = Object.keys(FACTION_DEFS) as FactionId[];
export const isFactionId = (id: string): id is FactionId => Object.hasOwn(FACTION_DEFS, id);

/** 实力 0..100；态度、关系 −100..100 */
export const FACTION_RANGE = { strength: [0, 100], attitude: [-100, 100], relation: [-100, 100] } as const;
/** 单个事件对单项的最大改动 */
export const MAX_FACTION_DELTA = 20;

/** 势力之间的关系按 ID 排序成一对（a < b），双向共用一个数值 */
export const relationPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
export const relationKey = (x: string, y: string): string => relationPair(x, y).join('|');

export const INITIAL_FACTION_RELATIONS: readonly { a: string; b: string; value: number }[] = [{ a: 'fac_blackwind', b: 'fac_qingyun', value: -30 }];

export type FactionEffect =
  | { kind: 'strength'; faction: FactionId; delta: number }
  /** 该势力对玩家的态度 */
  | { kind: 'attitude'; faction: FactionId; delta: number }
  | { kind: 'relation'; a: FactionId; b: FactionId; delta: number };

export interface FactionSnapshot {
  factions: Record<string, { strength: number; attitude: number }>;
  relations: Record<string, number>;
}

/** 一项实际发生的变化（夹到范围后）；没有变化的不记录 */
export type FactionChange =
  | { kind: 'strength' | 'attitude'; faction: string; from: number; to: number }
  | { kind: 'relation'; a: string; b: string; from: number; to: number };

const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, n));

/** 应用一组势力影响（纯函数）：每项改动限幅 ±MAX_FACTION_DELTA，结果夹回合法范围，返回实际变化 */
export function applyFactionEffects(state: FactionSnapshot, effects: readonly FactionEffect[]): { state: FactionSnapshot; changes: FactionChange[] } {
  const next: FactionSnapshot = { factions: Object.fromEntries(Object.entries(state.factions).map(([k, v]) => [k, { ...v }])), relations: { ...state.relations } };
  const changes: FactionChange[] = [];
  for (const e of effects) {
    const delta = Math.max(-MAX_FACTION_DELTA, Math.min(MAX_FACTION_DELTA, e.delta));
    if (e.kind === 'relation') {
      const [a, b] = relationPair(e.a, e.b);
      const k = `${a}|${b}`;
      if (!(k in next.relations)) throw new RangeError(`未知的势力关系：${k}`);
      const from = next.relations[k]!;
      const to = clamp(from + delta, FACTION_RANGE.relation);
      next.relations[k] = to;
      if (to !== from) changes.push({ kind: 'relation', a, b, from, to });
    } else {
      const f = next.factions[e.faction];
      if (!f) throw new RangeError(`未知的势力：${e.faction}`);
      const from = f[e.kind];
      const to = clamp(from + delta, FACTION_RANGE[e.kind]);
      f[e.kind] = to;
      if (to !== from) changes.push({ kind: e.kind, faction: e.faction, from, to });
    }
  }
  return { state: next, changes };
}

/** 实力的说法（玩家看到的是描述，不是裸数字） */
export const strengthLabel = (n: number): string => (n >= 75 ? '如日中天' : n >= 55 ? '强盛' : n >= 40 ? '势均力敌' : n >= 25 ? '衰微' : '风雨飘摇');
export const attitudeLabel = (n: number): string => (n >= 50 ? '亲近' : n >= 15 ? '友善' : n > -15 ? '观望' : n > -50 ? '戒备' : '敌视');
export const relationLabel = (n: number): string => (n >= 50 ? '盟友' : n >= 15 ? '交好' : n > -15 ? '平淡' : n > -50 ? '嫌隙' : '死敌');
