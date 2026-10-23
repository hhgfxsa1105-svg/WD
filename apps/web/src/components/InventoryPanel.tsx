import type { InventoryItem } from '@jhz/contracts';
import { GradeTag } from './GradeTag';

export function InventoryPanel({ items }: { items: InventoryItem[] }) {
  if (items.length === 0) return <p className="empty">背包里还没有物品</p>;
  return (
    <ul className="inv" aria-label="背包物品">
      {items.map((it) => (
        <li key={it.itemId}>
          <GradeTag grade={it.grade} />
          <div>
            <span className="nm">{it.name}</span>
            <small>突破时可选用，提高成功率</small>
          </div>
          <span className="qty">×{it.quantity}</span>
        </li>
      ))}
    </ul>
  );
}
