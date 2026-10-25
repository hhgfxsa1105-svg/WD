/**
 * 世界静态定义：地点与 NPC。显示文字（名字、身份、简介）只在这里，数据库只存会变化的状态，
 * 所以改名字不需要迁移，实体 ID 是唯一的稳定引用。
 */

/** 地区：地点按地区分组（地图按地区展示） */
export const REGION_DEFS = {
  region_qingyun: { name: '青云山', summary: '青云派的所在，群山环抱。' },
  region_foot: { name: '山下', summary: '山门之外的世界。' },
} as const satisfies Record<string, { name: string; summary: string }>;
export type RegionId = keyof typeof REGION_DEFS;
export const isRegionId = (id: string): id is RegionId => Object.hasOwn(REGION_DEFS, id);

export interface LocationDef {
  name: string;
  region: RegionId;
  /** 站在这里时才看得到的描述（相邻但没去过的地点只显示名字与状态） */
  description: string;
}

export const LOCATION_DEFS = {
  loc_qingyun_gate: { name: '青云山 · 山门', region: 'region_qingyun', description: '两根青石门柱立在山口，门外是下山的路，门内钟声隐约。' },
  loc_qingyun_yard: { name: '青云山 · 练功场', region: 'region_qingyun', description: '青石铺成的宽阔场地，兵器架立在四周，常有弟子在此练功。' },
  loc_qingyun_hall: { name: '青云山 · 大殿', region: 'region_qingyun', description: '殿内香烟缭绕，正中供着青云派历代祖师的牌位。' },
  loc_qingyun_library: { name: '青云山 · 藏经阁', region: 'region_qingyun', description: '三层木楼，书卷的气味扑面而来，窗边的案上总摊着一本旧书。' },
  loc_foot_path: { name: '山下 · 山道', region: 'region_foot', description: '一条石阶与土路交错的山道，两侧松林幽深，是上下山的必经之路。' },
  loc_foot_town: { name: '山下 · 小镇', region: 'region_foot', description: '山脚的小镇，客栈、茶摊和杂货铺沿街排开，往来的行人不少。' },
} as const satisfies Record<string, LocationDef>;
export type LocationId = keyof typeof LOCATION_DEFS;

export interface NpcDef {
  name: string;
  role: string;
  /** 初始所在地点 */
  homeLocationId: LocationId;
  intro: string;
  /** 初始目标（会随世界演化，运行时状态存在数据库里） */
  goals: readonly string[];
}

export const NPC_DEFS = {
  npc_gate_guard: { name: '赵铁牛', role: '守门弟子', homeLocationId: 'loc_qingyun_gate', intro: '一个憨厚的年轻弟子，把守山门已有三年。', goals: ['守好山门'] },
  npc_senior_sister: { name: '苏晚晴', role: '大师姐', homeLocationId: 'loc_qingyun_yard', intro: '剑法出众，对师弟师妹要求严格，却从不真的责怪。', goals: ['督促同门练功', '在下次比试中保住第一'] },
  npc_master_qingyun: { name: '青云真人', role: '掌门', homeLocationId: 'loc_qingyun_hall', intro: '须发半白，话不多，目光却让人不敢隐瞒。', goals: ['为青云山寻一位可托付的传人'] },
  npc_librarian: { name: '陆先生', role: '藏经阁执事', homeLocationId: 'loc_qingyun_library', intro: '总在翻一本旧书，对每一卷典籍的来历都如数家珍。', goals: ['整理残破的旧典'] },
} as const satisfies Record<string, NpcDef>;
export type NpcId = keyof typeof NPC_DEFS;

export const NPC_STATUSES = ['active', 'away', 'resting'] as const;
export type NpcStatus = (typeof NPC_STATUSES)[number];

export const isNpcId = (id: string): id is NpcId => Object.hasOwn(NPC_DEFS, id);
export const isLocationId = (id: string): id is LocationId => Object.hasOwn(LOCATION_DEFS, id);
export const locationName = (id: string): string | null => (isLocationId(id) ? LOCATION_DEFS[id].name : null);

/* ------------------------------------------------------------------ */
/* 关系：方向固定为「从 NPC 指向对象」（对象可以是玩家或另一个 NPC）        */
/* ------------------------------------------------------------------ */

export const RELATION_TARGET_TYPES = ['player', 'npc'] as const;
export type RelationTargetType = (typeof RELATION_TARGET_TYPES)[number];

/** 数值范围固定：好感可为负，信任与敌意不为负 */
export const RELATION_RANGE = {
  affinity: { min: -100, max: 100 },
  trust: { min: 0, max: 100 },
  hostility: { min: 0, max: 100 },
} as const;
/** 单次事件对每个数值的最大改变量，避免一次对话把关系推到极端 */
export const RELATION_MAX_STEP = 20;

export interface RelationValues {
  affinity: number;
  trust: number;
  hostility: number;
}
export type RelationDelta = Partial<RelationValues>;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 把关系数值夹回合法范围（对 NaN、小数、超界都安全） */
export function clampRelation(v: RelationValues): RelationValues {
  const fix = (n: number, r: { min: number; max: number }) => clamp(Number.isFinite(n) ? Math.round(n) : 0, r.min, r.max);
  return { affinity: fix(v.affinity, RELATION_RANGE.affinity), trust: fix(v.trust, RELATION_RANGE.trust), hostility: fix(v.hostility, RELATION_RANGE.hostility) };
}

/** 应用一次关系变化：每项先限幅到 ±RELATION_MAX_STEP，再夹回合法范围 */
export function applyRelationDelta(current: RelationValues, delta: RelationDelta): RelationValues {
  const step = (d: number | undefined) => (d === undefined || !Number.isFinite(d) ? 0 : clamp(Math.round(d), -RELATION_MAX_STEP, RELATION_MAX_STEP));
  return clampRelation({
    affinity: current.affinity + step(delta.affinity),
    trust: current.trust + step(delta.trust),
    hostility: current.hostility + step(delta.hostility),
  });
}

export interface RelationSeed extends RelationValues {
  npcId: NpcId;
  targetType: RelationTargetType;
  targetId: string;
}

/** 初始关系：NPC 对玩家与 NPC 之间；方向为 npcId → target */
export const INITIAL_RELATIONS: readonly RelationSeed[] = [
  { npcId: 'npc_gate_guard', targetType: 'player', targetId: 'player_1', affinity: 10, trust: 20, hostility: 0 },
  { npcId: 'npc_senior_sister', targetType: 'player', targetId: 'player_1', affinity: 20, trust: 30, hostility: 0 },
  { npcId: 'npc_master_qingyun', targetType: 'player', targetId: 'player_1', affinity: 5, trust: 10, hostility: 0 },
  { npcId: 'npc_librarian', targetType: 'player', targetId: 'player_1', affinity: 0, trust: 10, hostility: 0 },
  { npcId: 'npc_master_qingyun', targetType: 'npc', targetId: 'npc_senior_sister', affinity: 40, trust: 80, hostility: 0 },
  { npcId: 'npc_senior_sister', targetType: 'npc', targetId: 'npc_master_qingyun', affinity: 60, trust: 90, hostility: 0 },
  { npcId: 'npc_gate_guard', targetType: 'npc', targetId: 'npc_senior_sister', affinity: 30, trust: 50, hostility: 0 },
];

/* ------------------------------------------------------------------ */
/* 移动：地点之间的连接、体力与耗时                                        */
/* ------------------------------------------------------------------ */

/** 两个地点之间的一条路（无向）：每条路单独定义体力消耗与游戏内耗时（分钟） */
export interface LinkDef {
  a: LocationId;
  b: LocationId;
  stamina: number;
  /** 走完这条路所需的游戏分钟（游戏时钟由 T-022a 接入） */
  minutes: number;
}

/** 山门 — 练功场 — 大殿；练功场 — 藏经阁；山门 — 山道 — 小镇 */
export const LOCATION_LINKS: readonly LinkDef[] = [
  { a: 'loc_qingyun_gate', b: 'loc_qingyun_yard', stamina: 3, minutes: 30 },
  { a: 'loc_qingyun_yard', b: 'loc_qingyun_hall', stamina: 3, minutes: 30 },
  { a: 'loc_qingyun_yard', b: 'loc_qingyun_library', stamina: 3, minutes: 30 },
  { a: 'loc_qingyun_gate', b: 'loc_foot_path', stamina: 3, minutes: 60 },
  { a: 'loc_foot_path', b: 'loc_foot_town', stamina: 3, minutes: 60 },
];

export const linkBetween = (x: string, y: string): LinkDef | null => LOCATION_LINKS.find((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x)) ?? null;

export const areAdjacent = (x: string, y: string): boolean => linkBetween(x, y) !== null;

/** 从某地点出发一步能到的地点 */
export const neighborsOf = (id: string): LocationId[] => LOCATION_LINKS.flatMap((l) => (l.a === id ? [l.b] : l.b === id ? [l.a] : []));

/** 两个相邻地点之间的体力与耗时；不相邻返回 null */
export const moveCost = (x: string, y: string): { stamina: number; minutes: number } | null => {
  const l = linkBetween(x, y);
  return l ? { stamina: l.stamina, minutes: l.minutes } : null;
};

/* ------------------------------------------------------------------ */
/* 地点的可变状态                                                       */
/* ------------------------------------------------------------------ */

export const LOCATION_STATUSES = ['open', 'blocked'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];
/** 封锁原因的长度上限（原因由事件给出，是展示文字） */
export const LOCATION_REASON_MAX = 60;

/** 初始时已经去过的地点：只有出生的山门 */
export const INITIAL_VISITED: readonly LocationId[] = ['loc_qingyun_gate'];
