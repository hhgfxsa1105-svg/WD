import { useCallback, useEffect, useRef, useState } from 'react';
import { pillGradeOf } from '@jhz/game-rules';
import type { ActionResponse, CultivationJob, CultivationResponse, FixedActionId, InventoryItem, PlayerState } from '@jhz/contracts';
import {
  ApiError,
  fetchCultivation,
  fetchInventory,
  fetchPlayerState,
  settleCultivation,
  startCultivation,
  stopCultivation,
  submitBreakthrough,
  submitFixedAction,
} from './api/client';
import { createKeyStore } from './api/idempotency';
import { formatChanges, type LogChip } from './changes';
import { GRADE_LABEL, REALM_LABEL } from './labels';
import { INITIAL_LOG, hourLabel, type LogEntry } from './log';

const AUTO_SETTLE_MS = 30_000;
const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : '发生未知错误，请重试');

export function useGame() {
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [job, setJob] = useState<CultivationJob | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>(INITIAL_LOG);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busyRef = useRef(false);
  const keys = useRef(createKeyStore());

  const append = useCallback((entry: Omit<LogEntry, 'id' | 'time'>) => {
    setLog((l) => [...l, { ...entry, id: l.length, time: hourLabel(l.length) }]);
  }, []);

  const applyCultivation = useCallback(
    (r: CultivationResponse, quiet = false) => {
      setPlayer(r.player);
      setJob(r.job);
      setServerOffset(r.serverNow - Date.now());
      if (r.changes.length > 0) {
        append({
          text: '你静坐吐纳，不觉时光流转。',
          chips: formatChanges(r.changes),
          sub: `放置修炼 · 结算 ${r.ticks} 分钟`,
        });
      } else if (!quiet) {
        setNotice('暂无可领取的收益');
      }
      if (r.notice) append({ text: '周身真气盈满，似乎触到了一道无形的关隘。', chips: [], sub: r.notice, system: true });
    },
    [append],
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
    Promise.all([fetchPlayerState(), fetchInventory(), fetchCultivation()]).then(
      async ([p, inv, c]) => {
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
        append({ text: r.narrative ?? '（叙事暂不可用）', chips: formatChanges(r.changes) });
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
    const before = player;
    await guarded(async () => {
      const fp = `breakthrough:${pillItemId ?? ''}`;
      let r: ActionResponse;
      try {
        r = await submitBreakthrough(pillItemId, keys.current.keyFor(fp));
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'NETWORK')) keys.current.clear(fp);
        throw e;
      }
      keys.current.clear(fp);
      handled = true;
      setPlayer(r.player);
      const b = r.breakthrough!;
      const pill = pillItemId ? inventory.find((i) => i.itemId === pillItemId) : undefined;
      const sub = [
        `成功率 ${b.chancePercent}% · 掷点 ${b.roll.toFixed(2)}`,
        pill ? `消耗${pill.name} ×1` : null,
        b.outcome === 'failure' ? '冷却 24 小时' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const chips: LogChip[] = formatChanges(r.changes.filter((c) => !(b.outcome === 'success' && c.stat === 'realmProgress')));
      if (b.outcome === 'success' && before) {
        chips.unshift({ text: `境界 ${REALM_LABEL[before.realm]}→${REALM_LABEL[r.player.realm]}`, tone: 'up' });
      }
      append({ text: r.narrative ?? '', chips, sub });
      if (pillItemId) setInventory(await fetchInventory().catch(() => inventory));
    });
    return handled;
  };

  return {
    player,
    inventory,
    job,
    serverOffset,
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
