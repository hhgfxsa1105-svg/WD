import { useCallback, useEffect, useState } from 'react';
import { RULES } from '@jhz/game-rules';
import type { FixedActionId, PlayerState } from '@jhz/contracts';
import { ApiError, fetchPlayerState, submitFixedAction } from './api/client';
import { formatChanges } from './changes';
import { ActionPanel } from './components/ActionPanel';
import { BottomNav, NAV_ITEMS } from './components/BottomNav';
import { CharacterCard } from './components/CharacterCard';
import { LocationBar } from './components/LocationBar';
import { LogPanel } from './components/LogPanel';
import { Sheet } from './components/Sheet';
import { SideRail } from './components/SideRail';
import { INITIAL_LOG, hourLabel, type LogEntry } from './log';

const isNavItem = (n: string): boolean => (NAV_ITEMS as readonly string[]).includes(n);
const messageOf = (e: unknown): string => (e instanceof ApiError ? e.message : '发生未知错误，请重试');

export function App() {
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>(INITIAL_LOG);
  const [sheet, setSheet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    fetchPlayerState().then(setPlayer, (e) => setLoadError(messageOf(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (actionId: FixedActionId) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await submitFixedAction(actionId);
      setPlayer(r.player);
      setLog((l) => [
        ...l,
        { id: l.length, time: hourLabel(l.length), text: r.narrative ?? '（叙事暂不可用）', chips: formatChanges(r.changes) },
      ]);
    } catch (e) {
      setActionError(messageOf(e));
      if (e instanceof ApiError && e.code === 'CONFLICT') load(); // 状态已变化，重新同步
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) => {
    setActionError(null);
    setSheet((cur) => (cur === name ? null : name));
  };

  if (!player) {
    return (
      <div className="boot" role={loadError ? 'alert' : 'status'}>
        <span className="brand-boot">江湖志</span>
        <p>{loadError ?? '正在读取存档…'}</p>
        {loadError && (
          <button type="button" onClick={load}>
            重试
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="game">
      <SideRail unreadMessages onOpen={toggle} />
      <main className="col">
        <CharacterCard player={player} />
        <LocationBar location={player.location} time={`晴 · ${hourLabel(log.length - 1)}`} />
        <LogPanel entries={log} />
        <BottomNav active={sheet && isNavItem(sheet) ? sheet : null} onOpen={toggle} />
        {sheet && (
          <Sheet title={sheet} onClose={() => setSheet(null)}>
            {sheet === '行动' ? (
              <ActionPanel
                busy={busy}
                canCultivate={player.stamina >= RULES.cultivate.staminaCost}
                error={actionError}
                onCultivate={() => run('cultivate')}
                onRest={() => run('rest')}
              />
            ) : (
              <p className="soon">{sheet}功能将在后续阶段开放。</p>
            )}
          </Sheet>
        )}
      </main>
    </div>
  );
}
