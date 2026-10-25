import { randomUUID } from 'node:crypto';
import { type PersonalEventRecord, FactionHistorySchema, type FactionHistory, type FactionRelation, type FactionState, NewsItemSchema, LocationStateSchema, LogRecordSchema, NpcMemorySchema, NpcStateSchema, PlayerStateSchema, type AuditEvent, type LogRecord, type LocationState, type NewsItem, type NpcMemory, type NpcState, type WorldEventRecord, type PlayerState, type Relationship } from '@jhz/contracts';
import { INITIAL_GAME_MINUTES, INITIAL_INVENTORY, MAX_ADVANCE_MINUTES, createInitialPlayer, toInventoryItems } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { relationKey as factionRelationKey } from '@jhz/game-rules';
import { finishedPersonal, newPersonal, computeFactionEffects, initialFactionRelations, initialFactions, applyEventPatch, initialWorldEvent, initialWorldEvents, initialLocations, normalizeLocationStatus, relationChangeOf, applyQuestPatch, assertClaimable, assertQuest, initialQuestRecords, toQuestState, type QuestRecord, assertLocation, assertNpc, assertStatus, assertTarget, compactMemories, validateMemoryInput, initialNpcs, initialRelationships, nextRelationship, relationKey } from './world-rules.js';
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
  locations: Map<string, LocationState>;
  gameMinutes: number;
  worldEvents: Map<string, WorldEventRecord>;
  news: NewsItem[];
  factions: Map<string, FactionState>;
  factionRelations: Map<string, FactionRelation>;
  factionHistory: FactionHistory[];
  personal: PersonalEventRecord[];
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
  locations: new Map([...s.locations].map(([k, v]) => [k, { ...v }])),
  gameMinutes: s.gameMinutes,
  worldEvents: new Map([...s.worldEvents].map(([k, v]) => [k, { ...v }])),
  news: structuredClone(s.news),
  factions: new Map([...s.factions].map(([k, v]) => [k, { ...v }])),
  factionRelations: new Map([...s.factionRelations].map(([k, v]) => [k, { ...v }])),
  factionHistory: structuredClone(s.factionHistory),
  personal: structuredClone(s.personal),
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
    gameMinutes: () => s.gameMinutes,
    worldEvents: () => [...s.worldEvents.values()].map((e) => ({ ...e })),
    ensureWorldEvent(id) {
      if (!s.worldEvents.has(id)) s.worldEvents.set(id, initialWorldEvent(id));
      return { ...s.worldEvents.get(id)! };
    },
    updateWorldEvent(id, patch) {
      const cur = s.worldEvents.get(id);
      if (!cur) throw new AppError('NOT_FOUND', '没有这个事件');
      const next = applyEventPatch(cur, patch);
      s.worldEvents.set(id, next);
      return { ...next };
    },
    news: (limit) => structuredClone(limit === undefined ? s.news : s.news.slice(-limit)),
    counts: () => ({ news: s.news.length, factionHistory: s.factionHistory.length }),
    factions: () => [...s.factions.values()].map((f) => ({ ...f })).sort((x, y) => x.id.localeCompare(y.id)),
    factionRelations: () => [...s.factionRelations.values()].map((r) => ({ ...r })).sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b)),
    applyFactionEffects(effects) {
      const r = computeFactionEffects([...s.factions.values()], [...s.factionRelations.values()], effects);
      for (const f of r.factions) s.factions.set(f.id, f);
      for (const x of r.relations) s.factionRelations.set(factionRelationKey(x.a, x.b), x);
      return r.changes;
    },
    personalEvents: (limit) => structuredClone(limit === undefined ? s.personal : s.personal.slice(-limit)),
    activePersonalEvent: () => structuredClone(s.personal.find((e) => e.state === 'active') ?? null),
    findPersonalByKey: (key) => structuredClone(s.personal.find((e) => e.idempotencyKey === key) ?? null),
    createPersonalEvent(input) {
      if (s.personal.some((e) => e.state === 'active')) throw new AppError('CONFLICT', '你正忙着另一件事');
      if (input.idempotencyKey && s.personal.some((e) => e.idempotencyKey === input.idempotencyKey)) throw new AppError('CONFLICT', '幂等键已被使用');
      const rec = newPersonal(input);
      s.personal.push(rec);
      return structuredClone(rec);
    },
    finishPersonalEvent(id, patch) {
      const i = s.personal.findIndex((e) => e.id === id);
      if (i < 0) throw new AppError('NOT_FOUND', '没有这件事');
      s.personal[i] = finishedPersonal(s.personal[i]!, patch);
      return structuredClone(s.personal[i]!);
    },
    releasePersonalLock(id) {
      const i = s.personal.findIndex((e) => e.id === id);
      if (i < 0) throw new AppError('NOT_FOUND', '没有这件事');
      const cur = s.personal[i]!;
      if (cur.lock) s.personal[i] = { ...cur, lock: { ...cur.lock, released: true } };
      return structuredClone(s.personal[i]!);
    },
    factionHistory: (limit) => structuredClone(limit === undefined ? s.factionHistory : s.factionHistory.slice(-limit)),
    addFactionHistory(input) {
      if (!s.worldEvents.has(input.eventId)) throw new AppError('NOT_FOUND', '没有这个事件');
      if (s.factionHistory.some((h) => h.eventId === input.eventId)) throw new AppError('CONFLICT', '这个事件的势力变化已经记录过');
      const item = FactionHistorySchema.parse({ id: randomUUID(), ...input });
      s.factionHistory.push(item);
      return structuredClone(item);
    },
    addNews(input) {
      if (!s.worldEvents.has(input.eventId)) throw new AppError('NOT_FOUND', '没有这个事件');
      if (s.news.some((n) => n.eventId === input.eventId && n.kind === input.kind)) throw new AppError('CONFLICT', '这条消息已经发布过');
      const item = NewsItemSchema.parse({ id: randomUUID(), ...input });
      s.news.push(item);
      return { ...item };
    },
    advanceGameClock(minutes) {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_ADVANCE_MINUTES) throw new AppError('VALIDATION_FAILED', `游戏时间只能向前推进 0 到 ${MAX_ADVANCE_MINUTES} 分钟`);
      s.gameMinutes += minutes;
      return s.gameMinutes;
    },
    locations: () => [...s.locations.values()].map((l) => ({ ...l })),
    setLocationStatus(id, status, reason) {
      assertLocation(id);
      const n = normalizeLocationStatus(status, reason);
      const next = LocationStateSchema.parse({ ...s.locations.get(id)!, status: n.status, reason: n.reason });
      s.locations.set(id, next);
      return { ...next };
    },
    visitLocation(id) {
      assertLocation(id);
      const next = { ...s.locations.get(id)!, visited: true };
      s.locations.set(id, next);
      return { ...next };
    },
    relationHistory(npcId, target) {
      const key = relationKey(npcId, target.type, target.id);
      return s.events.flatMap((e) => {
        const c = relationChangeOf(key, e.before, e.after);
        if (!c) return [];
        const causeType = e.eventType === 'npc.memory' ? (s.events.find((x) => x.seq === e.seq - 1)?.eventType ?? e.eventType) : e.eventType;
        return [{ seq: e.seq, eventId: e.id, eventType: e.eventType, at: e.at, causeType, before: c.before, after: c.after }];
      });
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
      const log = input.log ? LogRecordSchema.parse({ ...input.log, id: seq, at: input.at, gameMinutes: s.gameMinutes }) : null;
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
    locations: new Map(initialLocations().map((l) => [l.id, l])),
    gameMinutes: INITIAL_GAME_MINUTES,
    worldEvents: new Map(initialWorldEvents().map((e) => [e.id, e])),
    news: [],
    factions: new Map(initialFactions().map((f) => [f.id, f])),
    factionRelations: new Map(initialFactionRelations().map((r) => [factionRelationKey(r.a, r.b), r])),
    factionHistory: [],
    personal: [],
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
