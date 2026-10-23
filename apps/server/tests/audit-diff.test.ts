import { describe, expect, it } from 'vitest';
import { createInitialPlayer } from '@jhz/game-rules';
import { snapshot, stateDiff } from '../src/modules/audit/diff.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';

describe('审计差异', () => {
  it('没有变化返回 null', () => {
    expect(stateDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBeNull();
  });

  it('只列出变化的字段', () => {
    expect(stateDiff({ a: 1, b: 2, c: { x: 1 } }, { a: 1, b: 3, c: { x: 2 } })).toEqual({
      before: { b: 2, c: { x: 1 } },
      after: { b: 3, c: { x: 2 } },
    });
  });

  it('库存按物品展开，只列变化的物品；用完（变为 0）也能看到', () => {
    const d = stateDiff({ inventory: { p1: 1, p2: 5 } }, { inventory: { p1: 0, p2: 5 } });
    expect(d).toEqual({ before: { inventory: { p1: 1 } }, after: { inventory: { p1: 0 } } });
  });

  it('字段新增与删除都能表现', () => {
    expect(stateDiff({ a: 1 }, { a: 1, b: 2 })).toEqual({ before: { b: undefined }, after: { b: 2 } });
  });

  it('快照：列出全部已知物品（含 0）与修炼状态', () => {
    const store = createMemoryGameStore();
    const snap = store.read((tx) => snapshot(tx));
    expect(snap.displayName).toBe(createInitialPlayer().displayName);
    expect(Object.keys(snap.inventory as object)).toHaveLength(5);
    expect((snap.inventory as Record<string, number>).pill_breakthrough_fan).toBe(1);
    expect((snap.inventory as Record<string, number>).pill_breakthrough_tian).toBe(0);
    expect(snap.cultivation).toBe('idle');
  });
});
