import { NpcMemorySchema, NpcStateSchema, QuestStateSchema, RelationshipSchema, type NpcMemory, type NpcState, type QuestState, type QuestStatus, type Relationship } from '@jhz/contracts';
import { isKnownItem, QUEST_DEFS, canTransition, initialQuestStatus, isQuestId, type QuestId, MEMORY_EVENTS, planCompaction, INITIAL_RELATIONS, NPC_DEFS, NPC_STATUSES, applyRelationDelta, isLocationId, isNpcId, type RelationDelta, type RelationTargetType } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';

/** 单机固定的玩家 ID（关系对象为玩家时使用） */
export const PLAYER_TARGET_ID = 'player_1';

export const relationKey = (npcId: string, targetType: string, targetId: string) => `${npcId}>${targetType}:${targetId}`;

/** 初始 NPC 状态：来自静态定义 */
export const initialNpcs = (): NpcState[] =>
  Object.entries(NPC_DEFS).map(([id, d]) => NpcStateSchema.parse({ id, locationId: d.homeLocationId, status: 'active', goals: [...d.goals] }));

export const initialRelationships = (): Relationship[] =>
  INITIAL_RELATIONS.map((r) => RelationshipSchema.parse({ npcId: r.npcId, targetType: r.targetType, targetId: r.targetId, affinity: r.affinity, trust: r.trust, hostility: r.hostility }));

export function assertNpc(id: string): void {
  if (!isNpcId(id)) throw new AppError('NOT_FOUND', '没有这个人物');
}
export function assertLocation(id: string): void {
  if (!isLocationId(id)) throw new AppError('NOT_FOUND', '没有这个地点');
}
export function assertStatus(status: string): void {
  if (!(NPC_STATUSES as readonly string[]).includes(status)) throw new AppError('VALIDATION_FAILED', '人物状态不合法');
}
/** 关系对象必须存在：玩家只有固定的一个；NPC 必须在定义里，且不能是自己 */
export function assertTarget(npcId: string, type: RelationTargetType, id: string): void {
  if (type === 'player') {
    if (id !== PLAYER_TARGET_ID) throw new AppError('NOT_FOUND', '没有这个对象');
    return;
  }
  if (type !== 'npc') throw new AppError('VALIDATION_FAILED', '关系对象类型不合法');
  assertNpc(id);
  if (id === npcId) throw new AppError('VALIDATION_FAILED', '人物不能与自己建立关系');
}

/** 计算新的关系：不存在则从 0 起算；数值由规则函数限幅并夹回合法范围 */
export function nextRelationship(current: Relationship | undefined, npcId: string, type: RelationTargetType, id: string, delta: RelationDelta): Relationship {
  const base = current ?? { npcId, targetType: type, targetId: id, affinity: 0, trust: 0, hostility: 0 };
  return RelationshipSchema.parse({ ...base, ...applyRelationDelta(base, delta) });
}

/**
 * 校验并规范化导入的人物世界：每个 NPC 与地点必须在定义里；关系的双方必须存在、不能指向自己、不得重复。
 * 文件里缺少的 NPC / 关系用初始值补齐。不合格时抛出带中文原因的 Error。
 */
export function mergeImportedWorld(
  world: { npcs: NpcState[]; relationships: Relationship[]; memories?: NpcMemory[]; quests?: QuestState[]; inventory?: { itemId: string; quantity: number }[] },
  now: number = Date.now(),
): { npcs: NpcState[]; relationships: Relationship[]; memories: NpcMemory[]; quests: QuestRecord[]; inventory: { itemId: string; quantity: number }[] | null } {
  const npcs = new Map(initialNpcs().map((n) => [n.id, n]));
  const seenNpc = new Set<string>();
  for (const n of world.npcs) {
    if (!isNpcId(n.id)) throw new Error(`存档里有未知人物：${n.id}`);
    if (!isLocationId(n.locationId)) throw new Error(`存档里人物 ${n.id} 在未知地点：${n.locationId}`);
    if (seenNpc.has(n.id)) throw new Error(`存档里人物重复：${n.id}`);
    seenNpc.add(n.id);
    npcs.set(n.id, n);
  }
  const rels = new Map(initialRelationships().map((r) => [relationKey(r.npcId, r.targetType, r.targetId), r]));
  const seenRel = new Set<string>();
  for (const r of world.relationships) {
    if (!isNpcId(r.npcId)) throw new Error(`存档里有未知人物的关系：${r.npcId}`);
    if (r.targetType === 'player' ? r.targetId !== PLAYER_TARGET_ID : !isNpcId(r.targetId) || r.targetId === r.npcId) {
      throw new Error(`存档里的关系对象不合法：${r.npcId} → ${r.targetType}:${r.targetId}`);
    }
    const k = relationKey(r.npcId, r.targetType, r.targetId);
    if (seenRel.has(k)) throw new Error(`存档里关系重复：${k}`);
    seenRel.add(k);
    rels.set(k, r);
  }
  // 记忆：原样保留（事件引用在导入时统一改为本次导入事件）；每个 NPC 的条数不得超过上限，ID 不得重复
  const memIds = new Set<string>();
  const perNpc = new Map<string, number>();
  for (const m of world.memories ?? []) {
    if (!isNpcId(m.npcId)) throw new Error(`存档里有未知人物的记忆：${m.npcId}`);
    if (memIds.has(m.id)) throw new Error(`存档里记忆重复：${m.id}`);
    memIds.add(m.id);
    perNpc.set(m.npcId, (perNpc.get(m.npcId) ?? 0) + 1);
    if (perNpc.get(m.npcId)! > MAX_IMPORTED_MEMORIES_PER_NPC) throw new Error(`存档里人物 ${m.npcId} 的记忆过多`);
  }
  const memories = (world.memories ?? []).map((m) => ({ ...m }));
  // 背包：物品必须是已知物品、不重复；缺省（null）表示不改动目标存档的背包
  let inventory: { itemId: string; quantity: number }[] | null = null;
  if (world.inventory) {
    const seenItem = new Set<string>();
    for (const it of world.inventory) {
      if (!isKnownItem(it.itemId)) throw new Error(`存档里有未知物品：${it.itemId}`);
      if (seenItem.has(it.itemId)) throw new Error(`存档里物品重复：${it.itemId}`);
      seenItem.add(it.itemId);
    }
    inventory = world.inventory.filter((i) => i.quantity > 0).map((i) => ({ ...i }));
  }
  return { npcs: [...npcs.values()], relationships: [...rels.values()], memories, quests: mergeImportedQuests(world.quests ?? [], now), inventory };
}

/** 校验并规范化导入的任务状态：任务必须存在、不重复；步数、状态与领取标记必须自洽；进行中或已完成的任务其前置任务必须已完成 */
export function mergeImportedQuests(imported: QuestState[], now: number): QuestRecord[] {
  const byId = new Map(initialQuestRecords().map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const q of imported) {
    if (!isQuestId(q.id)) throw new Error(`存档里有未知任务：${q.id}`);
    if (seen.has(q.id)) throw new Error(`存档里任务重复：${q.id}`);
    seen.add(q.id);
    const total = QUEST_DEFS[q.id].steps.length;
    if (q.stepIndex > total) throw new Error(`存档里任务 ${q.id} 的进度超过步骤总数`);
    if (q.status === 'completed' && q.stepIndex !== total) throw new Error(`存档里任务 ${q.id} 已完成但步骤没有全部完成`);
    if ((q.status === 'locked' || q.status === 'available') && q.stepIndex !== 0) throw new Error(`存档里任务 ${q.id} 尚未接取却有进度`);
    if (q.claimed && q.status !== 'completed') throw new Error(`存档里任务 ${q.id} 未完成却已领取奖励`);
    byId.set(q.id, {
      id: q.id,
      status: q.status,
      stepIndex: q.stepIndex,
      acceptedAt: q.status === 'locked' || q.status === 'available' ? null : now,
      finishedAt: q.status === 'completed' || q.status === 'failed' ? now : null,
      claimedAt: q.claimed ? now : null,
    });
  }
  for (const q of byId.values()) {
    assertQuest(q.id);
    const req = QUEST_DEFS[q.id].requires;
    if (req && (q.status === 'active' || q.status === 'completed') && byId.get(req)?.status !== 'completed') throw new Error(`存档里任务 ${q.id} 的前置任务 ${req} 尚未完成`);
  }
  return [...byId.values()];
}

/** 导入时每个 NPC 允许的记忆条数上限（正常游玩远低于此；防止构造畸形文件） */
export const MAX_IMPORTED_MEMORIES_PER_NPC = 500;

/** 校验一条待写入的事件记忆（长度、重要性、类型）；不合格抛 VALIDATION_FAILED */
export function validateMemoryInput(input: { type: string; summary: string; importance: number }): void {
  if (!Object.hasOwn(MEMORY_EVENTS, input.type)) throw new AppError('VALIDATION_FAILED', '记忆类型不合法');
  const probe = NpcMemorySchema.safeParse({ id: 'x', npcId: 'npc_x', eventId: 'e', type: input.type, summary: input.summary, importance: input.importance, sourceCount: 1, createdAt: 0 });
  if (!probe.success) throw new AppError('VALIDATION_FAILED', '记忆内容不合法');
}

/** 反复合并直到不超过上限（每轮至少减少一条，最多 5 轮）；storage 由调用方提供，保证在同一事务里执行 */
export function compactMemories(
  load: () => NpcMemory[],
  apply: (plan: NonNullable<ReturnType<typeof planCompaction>>) => void,
): void {
  for (let i = 0; i < 5; i++) {
    const plan = planCompaction(load());
    if (!plan) return;
    apply(plan);
  }
}

/** 导出存档用的世界快照：NPC 状态、关系与全部记忆 */
export function snapshotWorld(tx: { npcs(): NpcState[]; relationships(): Relationship[]; memories(npcId: string): NpcMemory[]; quests(): QuestState[]; inventory(): { itemId: string; quantity: number }[] }) {
  return { npcs: tx.npcs(), relationships: tx.relationships(), memories: tx.npcs().flatMap((n) => tx.memories(n.id)), quests: tx.quests(), inventory: tx.inventory().map((i) => ({ itemId: i.itemId, quantity: i.quantity })) };
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

/** 存档里的任务记录（含时间戳；对外的 QuestState 不带时间戳） */
export interface QuestRecord {
  id: string;
  status: QuestStatus;
  stepIndex: number;
  acceptedAt: number | null;
  finishedAt: number | null;
  claimedAt: number | null;
}

export const toQuestState = (r: QuestRecord): QuestState => QuestStateSchema.parse({ id: r.id, status: r.status, stepIndex: r.stepIndex, claimed: r.claimedAt !== null });

export const initialQuestRecords = (): QuestRecord[] =>
  (Object.keys(QUEST_DEFS) as QuestId[]).map((id) => ({ id, status: initialQuestStatus(id), stepIndex: 0, acceptedAt: null, finishedAt: null, claimedAt: null }));

export function assertQuest(id: string): asserts id is QuestId {
  if (!isQuestId(id)) throw new AppError('NOT_FOUND', '没有这个任务');
}

/**
 * 应用一次任务更新并返回新记录：状态流转必须合法；已完成步数只增不减且不超过步骤总数；
 * 时间戳随状态自动维护（离开 locked/available 记接取时间，进入终态记结束时间）。不合法抛 PRECONDITION_FAILED。
 */
export function applyQuestPatch(cur: QuestRecord, patch: { status?: QuestStatus; stepIndex?: number }, at: number): QuestRecord {
  assertQuest(cur.id);
  const total = QUEST_DEFS[cur.id].steps.length;
  const next: QuestRecord = { ...cur };
  if (patch.status !== undefined && patch.status !== cur.status) {
    if (!canTransition(cur.status, patch.status)) throw new AppError('PRECONDITION_FAILED', `任务状态不能从 ${cur.status} 变为 ${patch.status}`);
    next.status = patch.status;
    if (cur.acceptedAt === null && patch.status !== 'available') next.acceptedAt = at;
    if (patch.status === 'completed' || patch.status === 'failed') next.finishedAt = at;
  }
  if (patch.stepIndex !== undefined) {
    if (!Number.isInteger(patch.stepIndex) || patch.stepIndex < cur.stepIndex || patch.stepIndex > total) throw new AppError('PRECONDITION_FAILED', '任务进度只能前进，且不能超过步骤总数');
    next.stepIndex = patch.stepIndex;
  }
  return next;
}

/** 领取奖励的前置检查：必须已完成且尚未领取 */
export function assertClaimable(cur: QuestRecord): void {
  if (cur.status !== 'completed') throw new AppError('PRECONDITION_FAILED', '任务还没有完成，不能领取奖励');
  if (cur.claimedAt !== null) throw new AppError('PRECONDITION_FAILED', '奖励已经领取过了');
}

type Vals = { affinity: number; trust: number; hostility: number };
const asVals = (v: unknown): Vals | null => {
  const o = v as Partial<Vals> | null | undefined;
  return o && typeof o.affinity === 'number' && typeof o.trust === 'number' && typeof o.hostility === 'number' ? { affinity: o.affinity, trust: o.trust, hostility: o.hostility } : null;
};

/** 从审计事件的差异里取出某条关系的前后值；该事件没有改变这条关系则返回 null */
export function relationChangeOf(key: string, before: unknown, after: unknown): { before: Vals | null; after: Vals } | null {
  const a = asVals(((after as { relations?: Record<string, unknown> } | null)?.relations ?? {})[key]);
  if (!a) return null;
  return { before: asVals(((before as { relations?: Record<string, unknown> } | null)?.relations ?? {})[key]), after: a };
}
