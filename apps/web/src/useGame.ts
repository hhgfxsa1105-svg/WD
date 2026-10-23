import { useCallback, useEffect, useRef, useState } from 'react';
import { pillGradeOf } from '@jhz/game-rules';
import type {
  CultivationJob,
  CultivationResponse,
  FixedActionId,
  InventoryItem,
  LogRecord,
  PlayerState,
  WorldTimeResponse,
} from '@jhz/contracts';
import {
  ApiError,
  fetchCultivation,
  fetchInventory,
  fetchLog,
  fetchPlayerState,
  fetchWorldTime,
  settleCultivation,
  startCultivation,
  stopCultivation,
  submitBreakthrough,
  submitFixedAction,
} from './api/client';
import { createKeyStore } from './api/idempotency';
import { GRADE_LABEL } from './labels';
import { WELCOME, mergeEntries, toLogEntries, type LogEntry } from './log';

const AUTO_SETTLE_MS = 30_000;
const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : '发生未知错误，请重试');

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

  const busyRef = useRef(false);
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
    Promise.all([fetchPlayerState(), fetchInventory(), fetchCultivation(), fetchWorldTime().catch(() => null), fetchLog().catch(() => [] as LogRecord[])]).then(
      async ([p, inv, c, w, history]) => {
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
    }, resync);

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
    clearMessages: () => {
      setError(null);
      setNotice(null);
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
