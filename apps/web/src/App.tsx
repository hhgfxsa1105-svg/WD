import { useState } from 'react';
import { ActionPanel } from './components/ActionPanel';
import { BottomNav, NAV_ITEMS } from './components/BottomNav';
import { CharacterCard } from './components/CharacterCard';
import { LocationBar } from './components/LocationBar';
import { LogPanel } from './components/LogPanel';
import { Sheet } from './components/Sheet';
import { SideRail } from './components/SideRail';
import { INITIAL_LOG, createInitialPlayer, type LogEntry } from './mock/data';
import { cultivate, rest, type ActionResult } from './mock/engine';

const HOURS = ['辰时', '巳时', '午时', '未时', '申时', '酉时'];
const isNavItem = (n: string): boolean => (NAV_ITEMS as readonly string[]).includes(n);

export function App() {
  const [player, setPlayer] = useState(createInitialPlayer);
  const [log, setLog] = useState<LogEntry[]>(INITIAL_LOG);
  const [sheet, setSheet] = useState<string | null>(null);

  const time = HOURS[Math.min(log.length - 1, HOURS.length - 1)] ?? '辰时';

  const apply = (r: ActionResult | null) => {
    if (!r) return;
    setPlayer(r.player);
    setLog((l) => [
      ...l,
      { id: l.length, time: HOURS[Math.min(l.length, HOURS.length - 1)] ?? '', text: r.text, chips: r.chips },
    ]);
  };

  const toggle = (name: string) => setSheet((cur) => (cur === name ? null : name));

  return (
    <div className="game">
      <SideRail unreadMessages onOpen={toggle} />
      <main className="col">
        <CharacterCard player={player} />
        <LocationBar location={player.location} time={`晴 · ${time}`} />
        <LogPanel entries={log} />
        <BottomNav active={sheet && isNavItem(sheet) ? sheet : null} onOpen={toggle} />
        {sheet && (
          <Sheet title={sheet} onClose={() => setSheet(null)}>
            {sheet === '行动' ? (
              <ActionPanel
                canCultivate={player.stamina >= 10}
                onCultivate={() => apply(cultivate(player))}
                onRest={() => apply(rest(player))}
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
