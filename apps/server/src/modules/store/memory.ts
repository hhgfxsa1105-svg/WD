import { randomUUID } from 'node:crypto';
import { LogRecordSchema, PlayerStateSchema, type AuditEvent, type LogRecord, type PlayerState } from '@jhz/contracts';
import { INITIAL_INVENTORY, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { AiCallRecord, CultivationJobRecord, GameStore, GameTx, StoredAction } from './types.js';

interface State {
  player: PlayerState;
  items: Map<string, number>;
  jobs: Map<string, CultivationJobRecord>;
  actions: Map<string, StoredAction>;
  events: (AuditEvent & { log: LogRecord | null })[];
  seq: number;
}

const cloneState = (s: State): State => ({
  player: structuredClone(s.player),
  items: new Map(s.items),
  jobs: new Map([...s.jobs].map(([k, v]) => [k, { ...v }])),
  actions: new Map([...s.actions].map(([k, v]) => [k, structuredClone(v)])),
  events: structuredClone(s.events),
  seq: s.seq,
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
    findActionByKey: (key) => {
      const a = [...s.actions.values()].find((x) => x.idempotencyKey === key);
      return a ? structuredClone(a) : null;
    },
    getAction: (id) => {
      const a = s.actions.get(id);
      return a ? structuredClone(a) : null;
    },
    saveAction(action) {
      const dup = [...s.actions.values()].find((x) => x.idempotencyKey === action.idempotencyKey && x.id !== action.id);
      if (dup) throw new AppError('CONFLICT', '幂等键已被使用');
      s.actions.set(action.id, structuredClone(action));
    },
    appendEvent(input) {
      const seq = ++s.seq;
      const log = input.log ? LogRecordSchema.parse({ ...input.log, id: seq, at: input.at }) : null;
      s.events.push({
        seq,
        id: randomUUID(),
        actorId: 'player_1',
        actionId: input.actionId,
        eventType: input.eventType,
        before: input.before,
        after: input.after,
        at: input.at,
        log,
      });
      return log ? structuredClone(log) : null;
    },
    replaceLogNarrative(actionId, narrative) {
      const ev = s.events.find((e) => e.actionId === actionId && e.log);
      if (!ev?.log) return null;
      ev.log = LogRecordSchema.parse({ ...ev.log, narrative, ...(ev.log.narration ? { narration: { ...ev.log.narration, pending: false } } : {}) });
      return structuredClone(ev.log);
    },
    recentLog: (limit) =>
      structuredClone(s.events.flatMap((e) => (e.log ? [e.log] : [])).slice(-limit)),
    eventsForAction: (actionId) =>
      s.events
        .filter((e) => e.actionId === actionId)
        .map(({ log: _log, ...e }) => structuredClone(e)),
  };
}

export function createMemoryGameStore(initial: PlayerState = createInitialPlayer()): GameStore {
  let highWater: number | null = null;
  const aiCalls: AiCallRecord[] = [];
  let state: State = {
    player: PlayerStateSchema.parse(initial),
    items: new Map(INITIAL_INVENTORY.map((i) => [i.itemId, i.quantity])),
    jobs: new Map(),
    actions: new Map(),
    events: [],
    seq: 0,
  };
  return {
    aiLog: {
      reserve: (e) => {
        const id = randomUUID();
        aiCalls.push({ id, actionId: e.actionId, purpose: e.purpose, provider: e.provider, model: e.model, day: e.day, status: 'pending', errorKind: null, attempts: 0, latencyMs: null, promptTokens: null, completionTokens: null, totalTokens: null, requestChars: e.requestChars, responseChars: null, createdAt: e.at });
        return id;
      },
      finish: (id, r) => {
        const rec = aiCalls.find((x) => x.id === id);
        if (rec) Object.assign(rec, r);
      },
      usedOn: (day, purpose) => aiCalls.filter((x) => x.day === day && (!purpose || x.purpose === purpose)).length,
      recent: (limit) => structuredClone(aiCalls.slice(-limit).reverse()),
    },
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
