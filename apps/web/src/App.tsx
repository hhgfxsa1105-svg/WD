import { useState } from 'react';
import { ActionPanel } from './components/ActionPanel';
import { BottomNav, NAV_ITEMS } from './components/BottomNav';
import { BreakthroughModal } from './components/BreakthroughModal';
import { CharacterCard } from './components/CharacterCard';
import { InventoryPanel } from './components/InventoryPanel';
import { LocationBar } from './components/LocationBar';
import { MapPanel } from './components/MapPanel';
import { NpcPanel } from './components/NpcPanel';
import { QuestPanel } from './components/QuestPanel';
import { LogPanel } from './components/LogPanel';
import { Sheet } from './components/Sheet';
import { SideRail } from './components/SideRail';
import { aiView } from './ai';
import { hourLabel } from './log';
import { questNeedsAttention } from './npc';
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

  const ai = aiView(g.aiStatus, g.aiDown);
  const openNpc = sheet?.startsWith('npc:') ? (g.npcs.find((n) => `npc:${n.id}` === sheet) ?? null) : null;

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
      <SideRail unreadMessages questAlert={questNeedsAttention(g.quests)} onOpen={toggle} />
      <main className="col">
        <CharacterCard player={g.player} />
        <LocationBar location={g.player.location} time={`晴 · ${hourLabel(g.log.length - 1)}`} />
        <LogPanel entries={g.log} ai={ai} onRetryNarration={g.retryNarration} />
        <BottomNav active={sheet && isNavItem(sheet) ? sheet : null} onOpen={toggle} />
        {sheet && (
          <Sheet title={openNpc ? openNpc.name : sheet} onClose={() => setSheet(null)}>
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
                ai={ai}
                thinking={g.thinking}
                aiReply={g.aiReply}
                onFree={g.runFree}
              />
            ) : sheet === '背包' ? (
              <InventoryPanel items={g.inventory} />
            ) : sheet === '地图' ? (
              <MapPanel player={g.player} npcs={g.npcs} map={g.map} busy={g.busy} error={g.error} onMove={g.runMove} onOpenNpc={(id) => setSheet(`npc:${id}`)} />
            ) : sheet === '任务' ? (
              <QuestPanel quests={g.quests} busy={g.busy} error={g.error} onOp={g.runQuestOp} />
            ) : openNpc ? (
              <NpcPanel npc={openNpc} player={g.player} busy={g.busy} error={g.error} onGreet={g.greet} />
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
