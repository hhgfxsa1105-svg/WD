import {
  JoinEventResponseSchema,
  WorldEventViewSchema,
  type JoinEventResponse,
  type NewsItem,
  type StateChange,
  type WorldEventView,
} from '@jhz/contracts';
import {
  LOCATION_DEFS,
  MAX_EVENT_TRANSITIONS_PER_TICK,
  SYSTEM_EVENT_DEFS,
  applyPlayerEffects,
  eventEndsAt,
  gameDate,
  isLocationId,
  planSteps,
  type EventStep,
  type SystemEventDef,
} from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import { advanceQuests } from '../quest/service.js';
import type { GameStore, GameTx, LogPayload } from '../store/types.js';

type Defs = readonly SystemEventDef[];

const sortedDefs = (defs: Defs): SystemEventDef[] => [...defs].sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
const locName = (id: string) => (isLocationId(id) ? LOCATION_DEFS[id].name : id);
const newsLog = (text: string, note: string): LogPayload => ({ type: 'system', narrative: text, changes: [], breakthrough: null, idle: null, note });

export interface TickOptions {
  /** 现实时间戳（审计事件的 at） */
  at: number;
  /** 触发这次调度的行动；用于把后果事件关联到行动 */
  actionId: string | null;
  /** 注入事件表（测试用）；默认用静态时间线 */
  defs?: Defs;
  /** 覆盖单次调度上限（测试用） */
  maxTransitions?: number;
}

/** 世界效果：只能通过共享的世界状态（地点开放/封锁）产生，无论玩家是否参加都会发生 */
function applyWorldEffects(tx: GameTx, def: SystemEventDef): void {
  for (const w of def.worldEffects) tx.setLocationStatus(w.locationId, w.status, w.status === 'blocked' ? (w.reason ?? null) : null);
}

/**
 * 系统轨调度：按当前游戏时间推进所有到期的事件转换。每一步一个后果审计事件（含前后差异，
 * 传闻/新闻同时成为玩家可见日志）。
 * - 去重：只有状态机允许的转换会发生；(事件, 种类) 唯一的消息写不进第二条；重复调用不会重复结算。
 * - 一次很大的时间推进（如离线一整天）按事件开始时间顺序依次处理，错过放出时机的传闻不补发。
 * - 单次最多处理 MAX_EVENT_TRANSITIONS_PER_TICK 步；剩下的留在原状态，下一次调度继续。
 * 返回本次处理的转换数。
 */
export function tickWorld(tx: GameTx, opts: TickOptions): number {
  const cap = opts.maxTransitions ?? MAX_EVENT_TRANSITIONS_PER_TICK;
  let done = 0;
  const rows = new Map(tx.worldEvents().map((e) => [e.id, e]));
  for (const def of sortedDefs(opts.defs ?? SYSTEM_EVENT_DEFS)) {
    let row = rows.get(def.id) ?? tx.ensureWorldEvent(def.id);
    for (const step of planSteps(def, row, tx.gameMinutes())) {
      if (done >= cap) return done;
      applyStep(tx, def, step, opts);
      done++;
      row = tx.worldEvents().find((e) => e.id === def.id)!;
    }
  }
  return done;
}

function applyStep(tx: GameTx, def: SystemEventDef, step: EventStep, opts: TickOptions): void {
  const before = snapshot(tx);
  const now = tx.gameMinutes();
  let log: LogPayload | null = null;
  if (step.kind === 'rumor') {
    tx.updateWorldEvent(def.id, { rumored: true });
    if (!step.late) {
      tx.addNews({ eventId: def.id, kind: 'rumor', text: def.rumor, gameMinutes: now, participated: false });
      log = newsLog(def.rumor, '传闻');
    }
  } else if (step.kind === 'open') {
    tx.updateWorldEvent(def.id, { state: 'open' });
  } else {
    const endedAt = Math.min(now, eventEndsAt(def));
    tx.updateWorldEvent(def.id, { state: def.join ? 'missed' : 'resolved', resolvedAt: endedAt });
    applyWorldEffects(tx, def);
    tx.addNews({ eventId: def.id, kind: 'news', text: def.resolved, gameMinutes: endedAt, participated: false });
    log = newsLog(def.resolved, '新闻');
  }
  const diff = stateDiff(before, snapshot(tx));
  tx.appendEvent({ actionId: opts.actionId, eventType: `world.event.${step.kind}`, before: diff?.before ?? null, after: diff?.after ?? null, at: opts.at, log });
}

const when = (minutes: number) => ({ minutes, label: gameDate(minutes).label });

/** 玩家可见的事件列表：只放出传闻的不透露名字与地点；尚未传闻的完全不可见 */
export function eventViews(tx: GameTx, defs: Defs = SYSTEM_EVENT_DEFS): WorldEventView[] {
  const rows = new Map(tx.worldEvents().map((e) => [e.id, e]));
  const here = tx.player().location.id;
  const views: WorldEventView[] = [];
  for (const def of sortedDefs(defs)) {
    const row = rows.get(def.id);
    if (!row || (row.state === 'scheduled' && !row.rumored)) continue;
    const base = { id: def.id, state: row.state, startsAt: when(def.startAt), participated: row.participated };
    if (row.state === 'scheduled') {
      views.push(WorldEventViewSchema.parse({ ...base, title: null, summary: def.rumor, location: null, closesAt: null, canJoin: false, joinBlockedReason: null }));
      continue;
    }
    const location = def.locationId ? { id: def.locationId, name: locName(def.locationId) } : null;
    if (row.state === 'open') {
      const atPlace = !def.locationId || def.locationId === here;
      views.push(WorldEventViewSchema.parse({ ...base, title: def.title, summary: def.opening, location, closesAt: when(eventEndsAt(def)), canJoin: atPlace, joinBlockedReason: atPlace ? null : `你不在现场，要去${location!.name}` }));
    } else {
      const summary = row.participated && def.join ? def.join.news : def.resolved;
      views.push(WorldEventViewSchema.parse({ ...base, title: def.title, summary, location, closesAt: null, canJoin: false, joinBlockedReason: null }));
    }
  }
  return views;
}

export const newsList = (tx: GameTx, limit = 50): NewsItem[] => tx.news(limit).reverse();

/**
 * 玩家到场参加一个正在进行的事件：必须 open、人在事件地点。
 * 结果由程序定义（小额奖励、耗时），事件就此了结，世界效果照常发生，新闻里包含玩家。
 */
export function joinEvent(store: GameStore, eventId: string, at: number, defs: Defs = SYSTEM_EVENT_DEFS): JoinEventResponse {
  const def = defs.find((d) => d.id === eventId);
  if (!def) throw new AppError('NOT_FOUND', '没有这个事件');
  return store.transact((tx) => {
    const row = tx.worldEvents().find((e) => e.id === eventId);
    if (!row || (row.state === 'scheduled' && !row.rumored)) throw new AppError('NOT_FOUND', '没有这个事件');
    if (!def.join) throw new AppError('PRECONDITION_FAILED', '这件事轮不到你插手');
    if (row.state === 'scheduled') throw new AppError('PRECONDITION_FAILED', '还没到时候');
    if (row.participated) throw new AppError('PRECONDITION_FAILED', '你已经参加过了');
    if (row.state !== 'open') throw new AppError('PRECONDITION_FAILED', '这件事已经过去了');
    const player = tx.player();
    if (def.locationId && player.location.id !== def.locationId) throw new AppError('PRECONDITION_FAILED', `你不在现场，要去${locName(def.locationId)}`);

    const before = snapshot(tx);
    const effects = applyPlayerEffects(player, def.join.effects);
    tx.savePlayer(effects.player);
    tx.advanceGameClock(def.join.minutes);
    const now = tx.gameMinutes();
    tx.updateWorldEvent(def.id, { state: 'resolved', participated: true, resolvedAt: now });
    applyWorldEffects(tx, def);
    tx.addNews({ eventId: def.id, kind: 'news', text: def.join.news, gameMinutes: now, participated: true });
    const changes: StateChange[] = effects.changes;
    const diff = stateDiff(before, snapshot(tx));
    const log = tx.appendEvent({
      actionId: null,
      eventType: 'world.event.join',
      before: diff?.before ?? null,
      after: diff?.after ?? null,
      at,
      log: { type: 'fixed', narrative: def.join.narrative, changes, breakthrough: null, idle: null, note: null },
    });
    tickWorld(tx, { at, actionId: null, defs });
    advanceQuests(tx, at, null); // 修炼进度等变化可能让任务条件成立
    const event = eventViews(tx, defs).find((v) => v.id === def.id)!;
    return JoinEventResponseSchema.parse({ narrative: def.join.narrative, changes, player: tx.player(), log, event });
  });
}
