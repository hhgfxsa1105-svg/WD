import { z } from 'zod';
import { NpcMemorySchema, NpcStateSchema, PlayerStateSchema, QuestStateSchema, RelationshipSchema, type NpcMemory, type NpcState, type PlayerState, type QuestState, type Relationship } from '@jhz/contracts';

export const SAVE_FORMAT = 'jianghu-save';

const WorldSchema = z
  .object({
    npcs: z.array(NpcStateSchema).max(200),
    relationships: z.array(RelationshipSchema).max(2000),
    /** 记忆的事件引用无法跨存档保留，导入时按 NPC 合并为一条摘要；缺省视为没有 */
    memories: z.array(NpcMemorySchema).max(5000).default([]),
    /** 任务状态；缺省视为全部初始 */
    quests: z.array(QuestStateSchema).max(200).default([]),
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

export const buildSaveFile = (player: PlayerState, world: { npcs: NpcState[]; relationships: Relationship[]; memories: NpcMemory[]; quests: QuestState[] }, now = new Date()): SaveFile => ({
  format: SAVE_FORMAT,
  schemaVersion: 2,
  exportedAt: now.toISOString(),
  player,
  world: { npcs: world.npcs, relationships: world.relationships, memories: world.memories, quests: world.quests },
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
