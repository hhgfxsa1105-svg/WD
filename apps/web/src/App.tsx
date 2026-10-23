import { useState } from 'react';
import { ActionPanel } from './components/ActionPanel';
import { BottomNav, NAV_ITEMS } from './components/BottomNav';
import { BreakthroughModal } from './components/BreakthroughModal';
import { CharacterCard } from './components/CharacterCard';
import { InventoryPanel } from './components/InventoryPanel';
import { LocationBar } from './components/LocationBar';
import { LogPanel } from './components/LogPanel';
import { Sheet } from './components/Sheet';
import { SideRail } from './components/SideRail';
import { hourLabel } from './log';
import { useGame } from './useGame';

const isNavItem = (n: string): boolean => (NAV_ITEMS as readonly string[]).includes(n);

export function App() {
  const g = useGame();
  const [sheet, setSheet] = useState<string | null>(null);
  const [modal, setModal] = useState(false);

  const toggle = (name: string) => {
    g.clearMessages();
    setSheet((cur) => (cur === name ? null : name));
  };

  if (!g.player) {
    return (
      <div className="boot" role={g.loadError ? 'alert' : 'status'}>
        <span className="brand-boot">江湖志</span>
        <p>{g.loadError ?? '正在读取存档…'}</p>
        {g.loadError && (
          <button type="button" onClick={g.load}>
            重试
          </button>
        )}
      </div>
    );
  }

  const openBreakthrough = () => {
    g.clearMessages();
    setModal(true);
  };

  return (
    <div className="game">
      <SideRail unreadMessages onOpen={toggle} />
      <main className="col">
        <CharacterCard player={g.player} />
        <LocationBar location={g.player.location} time={`晴 · ${hourLabel(g.log.length - 1)}`} />
        <LogPanel entries={g.log} />
        <BottomNav active={sheet && isNavItem(sheet) ? sheet : null} onOpen={toggle} />
        {sheet && (
          <Sheet title={sheet} onClose={() => setSheet(null)}>
            {sheet === '行动' ? (
              <ActionPanel
                player={g.player}
                job={g.job}
                serverOffset={g.serverOffset}
                world={g.world}
                busy={g.busy}
                error={modal ? null : g.error}
                notice={g.notice}
                onStartIdle={g.startIdle}
                onSettleIdle={g.settleIdle}
                onStopIdle={g.stopIdle}
                onCultivate={() => g.runFixed('cultivate')}
                onRest={() => g.runFixed('rest')}
                onOpenBreakthrough={openBreakthrough}
              />
            ) : sheet === '背包' ? (
              <InventoryPanel items={g.inventory} />
            ) : (
              <p className="soon">{sheet}功能将在后续阶段开放。</p>
            )}
          </Sheet>
        )}
        {modal && (
          <BreakthroughModal
            player={g.player}
            pills={g.inventory.filter((i) => i.kind === 'breakthrough_pill')}
            busy={g.busy}
            error={g.error}
            onClose={() => {
              g.clearMessages();
              setModal(false);
            }}
            onConfirm={async (pill) => {
              if (await g.breakthrough(pill)) setModal(false);
            }}
          />
        )}
      </main>
    </div>
  );
}
