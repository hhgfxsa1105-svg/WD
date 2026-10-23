import { PlayerStateSchema, type PlayerState } from '@jhz/contracts';
import { INITIAL_INVENTORY, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { CultivationJobRecord, GameStore, GameTx } from './types.js';

interface State {
  player: PlayerState;
  items: Map<string, number>;
  jobs: Map<string, CultivationJobRecord>;
}

const cloneState = (s: State): State => ({
  player: structuredClone(s.player),
  items: new Map(s.items),
  jobs: new Map([...s.jobs].map(([k, v]) => [k, { ...v }])),
});

function makeTx(s: State): GameTx {
  return {
    player: () => structuredClone(s.player),
    savePlayer(next) {
      if (next.version !== s.player.version) throw new AppError('CONFLICT', '角色状态已变化，请刷新后重试');
      s.player = PlayerStateSchema.parse({ ...next, version: next.version + 1 });
      return structuredClone(s.player);
    },
    inventory: () => toInventoryItems([...s.items].map(([itemId, quantity]) => ({ itemId, quantity }))),
    takeItem(itemId, quantity) {
      const have = s.items.get(itemId) ?? 0;
      if (!Number.isInteger(quantity) || quantity <= 0 || have < quantity) {
        throw new AppError('PRECONDITION_FAILED', '物品数量不足');
      }
      s.items.set(itemId, have - quantity);
    },
    addItem(itemId, quantity) {
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('物品数量必须为正整数');
      const next = (s.items.get(itemId) ?? 0) + quantity;
      if (next > 9999) throw new AppError('PRECONDITION_FAILED', '物品数量超过上限');
      s.items.set(itemId, next);
    },
    runningJob() {
      const j = [...s.jobs.values()].find((x) => x.status === 'running');
      return j ? { ...j } : null;
    },
    saveJob(job) {
      if (job.status === 'running') {
        const other = [...s.jobs.values()].find((x) => x.status === 'running' && x.id !== job.id);
        if (other) throw new AppError('CONFLICT', '已有进行中的修炼');
      }
      s.jobs.set(job.id, { ...job });
    },
  };
}

export function createMemoryGameStore(initial: PlayerState = createInitialPlayer()): GameStore {
  let highWater: number | null = null;
  let state: State = {
    player: PlayerStateSchema.parse(initial),
    items: new Map(INITIAL_INVENTORY.map((i) => [i.itemId, i.quantity])),
    jobs: new Map(),
  };
  return {
    worldClock: {
      load: () => highWater,
      save: (t) => {
        highWater = Math.max(highWater ?? 0, t);
      },
    },
    read: (fn) => fn(makeTx(cloneState(state))),
    transact(fn) {
      const draft = cloneState(state);
      const result = fn(makeTx(draft));
      state = draft; // 仅在未抛出异常时提交
      return result;
    },
  };
}
