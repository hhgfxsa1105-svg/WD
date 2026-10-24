import { NpcMemorySchema, NpcStateSchema, RelationshipSchema, type NpcMemory, type NpcState, type Relationship } from '@jhz/contracts';
import { MEMORY_EVENTS, planCompaction, summarizeMemories, INITIAL_RELATIONS, NPC_DEFS, NPC_STATUSES, applyRelationDelta, isLocationId, isNpcId, type RelationDelta, type RelationTargetType } from '@jhz/game-rules';
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
export function mergeImportedWorld(world: { npcs: NpcState[]; relationships: Relationship[]; memories?: NpcMemory[] }): { npcs: NpcState[]; relationships: Relationship[]; memories: ImportedMemory[] } {
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
  // 记忆：事件引用无法跨存档保留，每个 NPC 的全部记忆合并成一条摘要
  const byNpc = new Map<string, NpcMemory[]>();
  for (const m of world.memories ?? []) {
    if (!isNpcId(m.npcId)) throw new Error(`存档里有未知人物的记忆：${m.npcId}`);
    byNpc.set(m.npcId, [...(byNpc.get(m.npcId) ?? []), m]);
  }
  const memories = [...byNpc.entries()].map(([npcId, list]) => ({ npcId, ...summarizeMemories(list) }));
  return { npcs: [...npcs.values()], relationships: [...rels.values()], memories };
}

export interface ImportedMemory {
  npcId: string;
  summary: string;
  importance: number;
  sourceCount: number;
  createdAt: number;
}

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
export function snapshotWorld(tx: { npcs(): NpcState[]; relationships(): Relationship[]; memories(npcId: string): NpcMemory[] }) {
  return { npcs: tx.npcs(), relationships: tx.relationships(), memories: tx.npcs().flatMap((n) => tx.memories(n.id)) };
}
