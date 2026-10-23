import { ITEM_DEFS } from '@jhz/game-rules';
import type { GameTx } from '../store/types.js';

type Snapshot = Record<string, unknown>;

/** 嵌套展开的键：差异只列出变化的条目（如 inventory.pill_x、relations.npc_a>player:player_1） */
const NESTED = ['inventory', 'npcs', 'relations'] as const;

/** 审计用快照：角色状态 + 全部已知物品的数量（0 也列出，避免「用完」被当作字段消失）+ 放置修炼状态 + NPC 状态与关系 */
export function snapshot(tx: GameTx): Snapshot {
  const qty = new Map(tx.inventory().map((i) => [i.itemId, i.quantity]));
  return {
    ...tx.player(),
    inventory: Object.fromEntries(Object.keys(ITEM_DEFS).map((id) => [id, qty.get(id) ?? 0])),
    cultivation: tx.runningJob() ? 'running' : 'idle',
    npcs: Object.fromEntries(tx.npcs().map((n) => [n.id, { locationId: n.locationId, status: n.status, goals: n.goals }])),
    relations: Object.fromEntries(tx.relationships().map((r) => [`${r.npcId}>${r.targetType}:${r.targetId}`, { affinity: r.affinity, trust: r.trust, hostility: r.hostility }])),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 两个快照的差异：只含变化的字段（嵌套对象按第一层键展开，如 inventory.pill_breakthrough_fan）。
 * 没有任何变化时返回 null。
 */
export function stateDiff(before: Snapshot, after: Snapshot): { before: Snapshot; after: Snapshot } | null {
  const b: Snapshot = {};
  const a: Snapshot = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if ((NESTED as readonly string[]).includes(key)) {
      const bi = (before[key] ?? {}) as Record<string, unknown>;
      const ai = (after[key] ?? {}) as Record<string, unknown>;
      const bo: Snapshot = {};
      const ao: Snapshot = {};
      for (const id of new Set([...Object.keys(bi), ...Object.keys(ai)])) {
        if (!same(bi[id], ai[id])) {
          bo[id] = bi[id];
          ao[id] = ai[id];
        }
      }
      b[key] = bo;
      a[key] = ao;
    } else {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return Object.keys(a).length === 0 ? null : { before: b, after: a };
}
