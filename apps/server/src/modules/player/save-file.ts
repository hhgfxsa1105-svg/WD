import { z } from 'zod';
import { PersonalEventRecordSchema, type PersonalEventRecord, FactionHistorySchema, FactionRelationSchema, FactionStateSchema, type FactionHistory, type FactionRelation, type FactionState, NewsItemSchema, WorldEventRecordSchema, LocationStateSchema, NpcMemorySchema, NpcStateSchema, PlayerStateSchema, QuestStateSchema, RelationshipSchema, type LocationState, type NewsItem, type WorldEventRecord, type NpcMemory, type NpcState, type PlayerState, type QuestState, type Relationship } from '@jhz/contracts';

export const SAVE_FORMAT = 'jianghu-save';

const WorldSchema = z
  .object({
    npcs: z.array(NpcStateSchema).max(200),
    relationships: z.array(RelationshipSchema).max(2000),
    /** 记忆的事件引用无法跨存档保留，导入时按 NPC 合并为一条摘要；缺省视为没有 */
    memories: z.array(NpcMemorySchema).max(5000).default([]),
    /** 任务状态；缺省视为全部初始 */
    quests: z.array(QuestStateSchema).max(200).default([]),
    /** 地点状态（封锁、是否去过）；缺省视为全部初始 */
    locations: z.array(LocationStateSchema).max(200).default([]),
    /** 游戏时间（游戏分钟）。缺省 = 旧存档：突破冷却是现实毫秒时间，导入时折算 */
    gameMinutes: z.number().int().min(0).optional(),
    /** 世界事件的状态与传闻/新闻；缺省视为全部初始、没有消息 */
    events: z.array(WorldEventRecordSchema).max(200).default([]),
    news: z.array(NewsItemSchema).max(1000).default([]),
    /** 势力：实力与对玩家的态度、势力间关系、事件造成的势力变化历史；缺省视为全部初始 */
    factions: z.array(FactionStateSchema).max(50).default([]),
    factionRelations: z.array(FactionRelationSchema).max(500).default([]),
    factionHistory: z.array(FactionHistorySchema).max(1000).default([]),
    /** 个人事件（含进行中的）；缺省视为没有。幂等键不进存档 */
    personalEvents: z.array(PersonalEventRecordSchema).max(200).default([]),
    /** 背包（物品 ID + 数量）；缺省表示不改动目标存档的背包 */
    inventory: z.array(z.object({ itemId: z.string().min(1).max(64), quantity: z.number().int().min(0).max(9999) }).strict()).max(200).optional(),
  })
  .strict();
export type SaveWorld = z.infer<typeof WorldSchema>;

const Base = { format: z.literal(SAVE_FORMAT), exportedAt: z.string().min(1), player: PlayerStateSchema };

/** 存档导出文件格式；导入时严格校验，不信任文件内容。v1 只有角色；v2 增加 NPC 状态与关系 */
export const SaveFileSchema = z.union([
  z.object({ ...Base, schemaVersion: z.literal(1) }).strict(),
  z.object({ ...Base, schemaVersion: z.literal(2), world: WorldSchema }).strict(),
]);
export type SaveFile = z.infer<typeof SaveFileSchema>;

export const buildSaveFile = (player: PlayerState, world: { npcs: NpcState[]; relationships: Relationship[]; memories: NpcMemory[]; quests: QuestState[]; locations?: LocationState[]; gameMinutes?: number; events?: WorldEventRecord[]; news?: NewsItem[]; factions?: FactionState[]; factionRelations?: FactionRelation[]; factionHistory?: FactionHistory[]; personalEvents?: PersonalEventRecord[]; inventory?: { itemId: string; quantity: number }[] }, now = new Date()): SaveFile => ({
  format: SAVE_FORMAT,
  schemaVersion: 2,
  exportedAt: now.toISOString(),
  player,
  world: { npcs: world.npcs, relationships: world.relationships, memories: world.memories, quests: world.quests, locations: world.locations ?? [], events: world.events ?? [], news: world.news ?? [], factions: world.factions ?? [], factionRelations: world.factionRelations ?? [], factionHistory: world.factionHistory ?? [], personalEvents: (world.personalEvents ?? []).map((e) => ({ ...e, idempotencyKey: null, fingerprint: null })), ...(world.gameMinutes !== undefined ? { gameMinutes: world.gameMinutes } : {}), ...(world.inventory ? { inventory: world.inventory } : {}) },
});

/** 解析存档文件；v1 的 world 为 null（导入时人物状态重置为初始） */
export function parseSaveFile(text: string): { player: PlayerState; world: SaveWorld | null; schemaVersion: 1 | 2 } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('存档文件不是有效的 JSON');
  }
  const r = SaveFileSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`存档文件格式无效：${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`);
  }
  return { player: r.data.player, world: r.data.schemaVersion === 2 ? r.data.world : null, schemaVersion: r.data.schemaVersion };
}
