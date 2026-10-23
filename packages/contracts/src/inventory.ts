import { z } from 'zod';
import { GradeSchema, ItemKindSchema } from './enums.js';
import { LIMITS } from './limits.js';

export const ItemIdSchema = z.string().min(1).max(LIMITS.itemId.max).regex(/^[a-z0-9_]+$/);

export const InventoryItemSchema = z
  .object({
    itemId: ItemIdSchema,
    name: z.string().min(1).max(32),
    kind: ItemKindSchema,
    grade: GradeSchema,
    quantity: z.number().int().min(0).max(9999),
  })
  .strict();
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryResponseSchema = z.object({ items: z.array(InventoryItemSchema).max(500) }).strict();
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;
