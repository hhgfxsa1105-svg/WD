import { GRADES, type Grade, type InventoryItem, type ItemKind } from '@jhz/contracts';

export interface ItemDef {
  name: string;
  kind: ItemKind;
  grade: Grade;
}

const GRADE_NAME: Record<Grade, string> = { fan: '凡阶', huang: '黄阶', xuan: '玄阶', di: '地阶', tian: '天阶' };

/** 物品定义表：突破丹药按评级各一种 */
export const ITEM_DEFS: Record<string, ItemDef> = Object.fromEntries(
  GRADES.map((g) => [`pill_breakthrough_${g}`, { name: `${GRADE_NAME[g]}突破丹`, kind: 'breakthrough_pill' as const, grade: g }]),
);

export const isKnownItem = (itemId: string): boolean => Object.hasOwn(ITEM_DEFS, itemId);

/** 突破丹药返回其评级；非突破丹药或未知物品返回 null */
export function pillGradeOf(itemId: string): Grade | null {
  const def = ITEM_DEFS[itemId];
  return def && def.kind === 'breakthrough_pill' ? def.grade : null;
}

/** 由库存行（物品 ID + 数量）生成带名称与评级的库存条目；数量为 0 的不显示，未知物品视为存档损坏 */
export function toInventoryItems(rows: { itemId: string; quantity: number }[]): InventoryItem[] {
  return rows
    .filter((r) => r.quantity > 0)
    .map((r) => {
      const def = ITEM_DEFS[r.itemId];
      if (!def) throw new Error(`未知物品：${r.itemId}`);
      return { itemId: r.itemId, name: def.name, kind: def.kind, grade: def.grade, quantity: r.quantity };
    })
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** 新存档的初始库存 */
export const INITIAL_INVENTORY: { itemId: string; quantity: number }[] = [{ itemId: 'pill_breakthrough_fan', quantity: 1 }];
