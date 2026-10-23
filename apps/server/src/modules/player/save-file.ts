import { z } from 'zod';
import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';

export const SAVE_FORMAT = 'jianghu-save';

/** 存档导出文件格式；导入时严格校验，不信任文件内容 */
export const SaveFileSchema = z
  .object({
    format: z.literal(SAVE_FORMAT),
    schemaVersion: z.literal(1),
    exportedAt: z.string().min(1),
    player: PlayerStateSchema,
  })
  .strict();
export type SaveFile = z.infer<typeof SaveFileSchema>;

export const buildSaveFile = (player: PlayerState, now = new Date()): SaveFile => ({
  format: SAVE_FORMAT,
  schemaVersion: 1,
  exportedAt: now.toISOString(),
  player,
});

export function parseSaveFile(text: string): SaveFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('存档文件不是有效的 JSON');
  }
  const r = SaveFileSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`存档文件格式无效：${r.error.issues[0]?.path.join('.') || '(root)'} ${r.error.issues[0]?.message ?? ''}`);
  }
  return r.data;
}
