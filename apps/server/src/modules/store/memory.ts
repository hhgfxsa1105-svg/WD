import { randomUUID } from 'node:crypto';
import { LogRecordSchema, NpcMemorySchema, NpcStateSchema, PlayerStateSchema, type AuditEvent, type LogRecord, type NpcMemory, type NpcState, type PlayerState, type Relationship } from '@jhz/contracts';
import { INITIAL_INVENTORY, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { applyQuestPatch, assertClaimable, assertQuest, initialQuestRecords, toQuestState, type QuestRecord, assertLocation, assertNpc, assertStatus, assertTarget, compactMemories, validateMemoryInput, initialNpcs, initialRelationships, nextRelationship, relationKey } from './world-rules.js';
import type { AiCallRecord, CultivationJobRecord, GameStore, GameTx, StoredAction } from './types.js';

interface State {
  player: PlayerState;
  items: Map<string, number>;
  jobs: Map<string, CultivationJobRecord>;
  actions: Map<string, StoredAction>;
  npcs: Map<string, NpcState>;
  relations: Map<string, Relationship>;
  memories: Map<string, NpcMemory>;
  quests: Map<string, QuestRecord>;
  events: (AuditEvent & { log: LogRecord | null })[];
  seq: number;
}

const cloneState = (s: State): State => ({
  player: structuredClone(s.player),
  items: new Map(s.items),
  jobs: new Map([...s.jobs].map(([k, v]) => [k, { ...v }])),
  actions: new Map([...s.actions].map(([k, v]) => [k, structuredClone(v)])),
  npcs: new Map([...s.npcs].map(([k, v]) => [k, structuredClone(v)])),
  relations: new Map([...s.relations].map(([k, v]) => [k, { ...v }])),
  memories: new Map([...s.memories].map(([k, v]) => [k, { ...v }])),
  quests: new Map([...s.quests].map(([k, v]) => [k, { ...v }])),
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
    quests: () => [...s.quests.values()].map(toQuestState),
    updateQuest(id, patch, at) {
      assertQuest(id);
      const next = applyQuestPatch(s.quests.get(id)!, patch, at);
      s.quests.set(id, next);
      return toQuestState(next);
    },
    markQuestClaimed(id, at) {
      assertQuest(id);
      const cur = s.quests.get(id)!;
      assertClaimable(cur);
      const next = { ...cur, claimedAt: at };
      s.quests.set(id, next);
      return toQuestState(next);
    },
    memories: (npcId) => [...s.memories.values()].filter((m) => m.npcId === npcId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((m) => ({ ...m })),
    memoryCounts() {
      const out: Record<string, number> = Object.fromEntries([...s.npcs.keys()].map((id) => [id, 0]));
      for (const m of s.memories.values()) out[m.npcId] = (out[m.npcId] ?? 0) + 1;
      return out;
    },
    addMemory(input) {
      assertNpc(input.npcId);
      validateMemoryInput(input);
      if (!s.events.some((e) => e.id === input.eventId)) throw new AppError('NOT_FOUND', '记忆引用的事件不存在');
      const mem = NpcMemorySchema.parse({ id: randomUUID(), npcId: input.npcId, eventId: input.eventId, type: input.type, summary: input.summary, importance: input.importance, sourceCount: 1, createdAt: input.at });
      s.memories.set(mem.id, mem);
      const mine = () => [...s.memories.values()].filter((m) => m.npcId === input.npcId);
      compactMemories(mine, (plan) => {
        for (const id of plan.mergeIds) s.memories.delete(id);
        const sum = NpcMemorySchema.parse({ id: randomUUID(), npcId: input.npcId, eventId: null, type: 'summary', ...plan.summary });
        s.memories.set(sum.id, sum);
      });
      return { ...(s.memories.get(mem.id) ?? mem) };
    },
    npcs: () => [...s.npcs.values()].map((n) => structuredClone(n)),
    relationships: () => [...s.relations.values()].map((r) => ({ ...r })),
    adjustRelationship(npcId, target, delta) {
      assertNpc(npcId);
      assertTarget(npcId, target.type, target.id);
      const key = relationKey(npcId, target.type, target.id);
      const next = nextRelationship(s.relations.get(key), npcId, target.type, target.id, delta);
      s.relations.set(key, next);
      return { ...next };
    },
    moveNpc(npcId, locationId) {
      assertNpc(npcId);
      assertLocation(locationId);
      const cur = s.npcs.get(npcId)!;
      const next = NpcStateSchema.parse({ ...cur, locationId });
      s.npcs.set(npcId, next);
      return structuredClone(next);
    },
    setNpcStatus(npcId, status) {
      assertNpc(npcId);
      assertStatus(status);
      const next = NpcStateSchema.parse({ ...s.npcs.get(npcId)!, status });
      s.npcs.set(npcId, next);
      return structuredClone(next);
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
        id: input.id ?? randomUUID(),
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
    npcs: new Map(initialNpcs().map((n) => [n.id, n])),
    memories: new Map(),
    quests: new Map(initialQuestRecords().map((q) => [q.id, q])),
    relations: new Map(initialRelationships().map((r) => [relationKey(r.npcId, r.targetType, r.targetId), r])),
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
