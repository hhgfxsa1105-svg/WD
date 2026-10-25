import { useCallback, useEffect, useRef, useState } from 'react';
import { pillGradeOf } from '@jhz/game-rules';
import type {
  CultivationJob,
  ActionResponse,
  AiStatusResponse,
  CultivationResponse,
  FixedActionId,
  GreetResponse,
  InventoryItem,
  LogRecord,
  NpcView,
  WorldEventView,
  WorldMapResponse,
  QuestOp,
  QuestView,
  PlayerState,
  WorldTimeResponse,
} from '@jhz/contracts';
import {
  ApiError,
  fetchAiStatus,
  fetchCultivation,
  fetchInventory,
  fetchLog,
  fetchEvents,
  fetchMap,
  joinWorldEvent,
  fetchNpcs,
  fetchQuests,
  greetNpc,
  fetchPlayerState,
  fetchWorldTime,
  retryNarration as apiRetryNarration,
  settleCultivation,
  startCultivation,
  stopCultivation,
  submitBreakthrough,
  submitFreeAction,
  submitMove,
  submitQuestOp,
  submitFixedAction,
} from './api/client';
import { createKeyStore } from './api/idempotency';
import { GRADE_LABEL } from './labels';
import { WELCOME, mergeEntries, replaceEntries, toLogEntries, type LogEntry } from './log';

const AUTO_SETTLE_MS = 30_000;
const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : '发生未知错误，请重试');

/** 自由行动后面板里显示的一行回复 */
export interface AiReply {
  tone: 'done' | 'ask' | 'warn';
  label: string;
  text: string;
}

export function useGame() {
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [job, setJob] = useState<CultivationJob | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [world, setWorld] = useState<WorldTimeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([WELCOME]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatusResponse | null>(null);
  /** 刚刚一次 AI 调用失败（成功或刷新后清除） */
  const [aiDown, setAiDown] = useState(false);
  const [aiReply, setAiReply] = useState<AiReply | null>(null);
  const [thinking, setThinking] = useState(false);
  const [quests, setQuests] = useState<QuestView[]>([]);
  const [npcs, setNpcs] = useState<NpcView[]>([]);
  const [map, setMap] = useState<WorldMapResponse | null>(null);
  const [events, setEvents] = useState<WorldEventView[]>([]);

  const busyRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const keys = useRef(createKeyStore());

  /** 追加服务端写入的日志记录；按序号去重，幂等重试回放同一条记录时不会重复显示 */
  const appendRecord = useCallback((record: LogRecord | null) => {
    if (record) setLog((l) => mergeEntries(l, toLogEntries(record)));
  }, []);

  const applyCultivation = useCallback(
    (r: CultivationResponse, quiet = false) => {
      setPlayer(r.player);
      setJob(r.job);
      setServerOffset(r.serverNow - Date.now());
      appendRecord(r.log);
      if (r.log || r.ticks > 0) void refreshRef.current(); // 有收益时修炼进度、游戏时间变了，任务提示可能随之出现
      if (!r.log && !quiet) setNotice('暂无可领取的收益');
    },
    [appendRecord],
  );

  /** 串行执行一次操作：忙碌期间忽略重复点击；统一错误提示 */
  const guarded = useCallback(async (fn: () => Promise<void>, onError?: (e: unknown) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
      onError?.(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([fetchPlayerState(), fetchInventory(), fetchCultivation(), fetchWorldTime().catch(() => null), fetchLog().catch(() => [] as LogRecord[]), fetchAiStatus().catch(() => null), fetchQuests().catch(() => [] as QuestView[]), fetchNpcs().catch(() => [] as NpcView[]), fetchMap().catch(() => null), fetchEvents().catch(() => [] as WorldEventView[])]).then(
      async ([p, inv, c, w, history, ai, qs, ns, mp, evs]) => {
        setAiStatus(ai);
        setQuests(qs);
        setNpcs(ns);
        setMap(mp);
        setEvents(evs);
        setWorld(w);
        setLog(mergeEntries([WELCOME], history.flatMap(toLogEntries)));
        setPlayer(p);
        setInventory(inv);
        setJob(c.job);
        setServerOffset(c.serverNow - Date.now());
        if (c.job) {
          // 打开页面时自动结算一次，领取离开期间累积的修炼收益
          try {
            applyCultivation(await settleCultivation(), true);
          } catch {
            /* 结算失败不影响进入游戏，稍后自动重试 */
          }
        }
      },
      (e) => setLoadError(messageOf(e)),
    );
  }, [applyCultivation]);
  useEffect(load, [load]);

  // 修炼进行中：每 30 秒自动结算
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => {
      if (busyRef.current) return;
      settleCultivation().then((r) => applyCultivation(r, true), () => undefined);
    }, AUTO_SETTLE_MS);
    return () => clearInterval(timer);
  }, [job, applyCultivation]);

  const resync = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'CONFLICT') load();
  };

  const runFixed = (actionId: FixedActionId) =>
    guarded(async () => {
      const fp = `fixed:${actionId}`;
      try {
        const r = await submitFixedAction(actionId, keys.current.keyFor(fp));
        keys.current.clear(fp);
        setPlayer(r.player);
        appendRecord(r.log);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp); // 网络失败时保留键，重试不会重复结算
        throw e;
      }
      await refreshWorld();
    }, resync);

  /**
   * 自由行动：玩家原话交给服务端（AI 只做意图解析，结算仍由服务端规则决定）。
   * 返回服务端的结果；失败或被拒绝时返回 null（错误已显示，输入框内容由调用方保留）。
   */
  const runFree = async (input: string): Promise<ActionResponse | null> => {
    let result: ActionResponse | null = null;
    setAiReply(null);
    await guarded(
      async () => {
        const fp = `free:${input}`;
        setThinking(true);
        try {
          let r: ActionResponse;
          try {
            r = await submitFreeAction(input, keys.current.keyFor(fp));
          } catch (e) {
            if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp); // 网络失败保留键，重试不会重复结算
            throw e;
          }
          keys.current.clear(fp);
          result = r;
          setAiDown(false);
          setPlayer(r.player);
          appendRecord(r.log);
          const ai = r.ai;
          if (ai && !ai.executed) setAiReply({ tone: 'ask', label: '没有执行任何行动', text: ai.clarification ?? r.narrative ?? '可以说得更具体些吗？' });
          else if (ai) setAiReply({ tone: 'done', label: 'AI 理解为', text: `${ai.intent}（已执行）${ai.actionType === 'check_status' && r.narrative ? `\n${r.narrative}` : ''}` });
          if (ai?.executed && ai.actionType === 'breakthrough') setInventory(await fetchInventory().catch(() => inventory));
          if (ai?.executed && (ai.actionType === 'start_idle' || ai.actionType === 'stop_idle')) {
            const c = await fetchCultivation().catch(() => null);
            if (c) setJob(c.job);
          }
          fetchAiStatus().then(setAiStatus, () => undefined);
          if (ai?.executed) await refreshWorld();
        } finally {
          setThinking(false);
        }
      },
      (e) => {
        // 自由行动的失败提示紧贴输入框显示（面板底部会被导航遮住）
        const unavailable = e instanceof ApiError && e.code === 'AI_UNAVAILABLE';
        if (unavailable) setAiDown(true);
        setError(null);
        setAiReply({ tone: 'warn', label: '没有执行任何行动', text: messageOf(e) });
        resync(e);
      },
    );
    return result;
  };

  /** 重新生成某条日志的叙事；成功返回 null，失败返回可直接展示的原因。不占用全局忙碌状态 */
  const retryingRef = useRef(new Set<string>());
  const retryNarration = async (actionId: string): Promise<string | null> => {
    if (retryingRef.current.has(actionId)) return null;
    retryingRef.current.add(actionId);
    try {
      const r = await apiRetryNarration(actionId);
      setAiDown(false);
      if (r.log) setLog((l) => replaceEntries(l, toLogEntries(r.log!)));
      fetchAiStatus().then(setAiStatus, () => undefined);
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AI_UNAVAILABLE') setAiDown(true);
      return messageOf(e);
    } finally {
      retryingRef.current.delete(actionId);
    }
  };


  /** 行动之后重新读取日志、任务与人物：服务端写入的任务进度提示、人物变化才会马上显示 */
  const refreshWorld = useCallback(async () => {
    const [history, qs, ns, mp, w, evs] = await Promise.all([fetchLog().catch(() => null), fetchQuests().catch(() => null), fetchNpcs().catch(() => null), fetchMap().catch(() => null), fetchWorldTime().catch(() => null), fetchEvents().catch(() => null)]);
    if (evs) setEvents(evs);
    if (history) setLog((l) => mergeEntries(l, history.flatMap(toLogEntries)));
    if (qs) setQuests(qs);
    if (ns) setNpcs(ns);
    if (mp) setMap(mp);
    if (w) setWorld(w);
  }, []);

  refreshRef.current = refreshWorld;

  /** 到场参加一个进行中的事件（在场与时机由服务端判定） */
  const runJoinEvent = (eventId: string) =>
    guarded(async () => {
      const r = await joinWorldEvent(eventId);
      setPlayer(r.player);
      appendRecord(r.log);
      await refreshWorld();
    }, resync);

  /** 前往相邻地点（相邻与体力由服务端判定） */
  const runMove = (locationId: string) =>
    guarded(async () => {
      const fp = `move:${locationId}`;
      try {
        const r = await submitMove(locationId, keys.current.keyFor(fp));
        keys.current.clear(fp);
        setPlayer(r.player);
        appendRecord(r.log);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp);
        throw e;
      }
      await refreshWorld();
    }, resync);

  /** 任务操作：接取、领取奖励、放弃 */
  const runQuestOp = (questId: string, op: QuestOp) =>
    guarded(async () => {
      const fp = `quest:${questId}:${op}`;
      try {
        const r = await submitQuestOp(questId, op, keys.current.keyFor(fp));
        keys.current.clear(fp);
        setPlayer(r.player);
        appendRecord(r.log);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp);
        throw e;
      }
      if (op === 'claim') setInventory(await fetchInventory().catch(() => inventory));
      await refreshWorld();
    }, resync);

  /** 打招呼：不依赖 AI。成功返回结果；失败时错误已显示，返回 null */
  const greet = async (npcId: string): Promise<GreetResponse | null> => {
    let out: GreetResponse | null = null;
    await guarded(async () => {
      const r = await greetNpc(npcId);
      appendRecord(r.log);
      await refreshWorld();
      out = r;
    }, resync);
    return out;
  };

  /** quiet=true：没有收益时不提示（开始、停止不该出现「暂无可领取」） */
  const idle = (call: () => Promise<CultivationResponse>, quiet: boolean) =>
    guarded(async () => applyCultivation(await call(), quiet), resync);

  /** 返回 true 表示请求已被服务端处理（成功或失败的突破都算），弹窗可以关闭 */
  const breakthrough = async (pillItemId: string | null): Promise<boolean> => {
    let handled = false;
    await guarded(async () => {
      const fp = `breakthrough:${pillItemId ?? ''}`;
      let r: Awaited<ReturnType<typeof submitBreakthrough>>;
      try {
        r = await submitBreakthrough(pillItemId, keys.current.keyFor(fp));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp);
        throw e;
      }
      keys.current.clear(fp);
      handled = true;
      setPlayer(r.player);
      appendRecord(r.log);
      if (pillItemId) setInventory(await fetchInventory().catch(() => inventory));
      await refreshWorld();
    });
    return handled;
  };

  return {
    player,
    inventory,
    job,
    serverOffset,
    world,
    loadError,
    log,
    busy,
    error,
    notice,
    quests,
    npcs,
    map,
    events,
    runJoinEvent,
    runMove,
    runQuestOp,
    greet,
    refreshWorld,
    aiStatus,
    aiDown,
    aiReply,
    thinking,
    runFree,
    retryNarration,
    clearMessages: () => {
      setError(null);
      setNotice(null);
      setAiReply(null);
    },
    load,
    runFixed,
    startIdle: () => idle(startCultivation, true),
    settleIdle: () => idle(settleCultivation, false),
    stopIdle: () => idle(stopCultivation, true),
    breakthrough,
    pillLabel: (itemId: string) => {
      const g = pillGradeOf(itemId);
      return g ? GRADE_LABEL[g] : '';
    },
  };
}
