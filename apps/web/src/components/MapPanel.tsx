import type { NpcView, PlayerState, WorldMapResponse } from '@jhz/contracts';
import { attitudeText } from '../npc';

interface Props {
  player: PlayerState;
  npcs: NpcView[];
  map: WorldMapResponse | null;
  busy: boolean;
  error: string | null;
  onMove: (locationId: string) => void;
  onOpenNpc: (npcId: string) => void;
}

export function MapPanel({ player, npcs, map, busy, error, onMove, onOpenNpc }: Props) {
  const here = npcs.filter((n) => n.location.id === player.location.id);
  const exits = map?.exits ?? [];

  return (
    <>
      <section className="w-sec" aria-label="能去的地方">
        <h4>
          能去的地方<small>{map ? `${map.current.region.name} · ${map.current.name}` : ''}</small>
        </h4>
        {exits.length === 0 && <p className="w-empty">暂时没有可去的地方。</p>}
        {exits.map((x) => {
          const tired = player.stamina < x.stamina;
          const blocked = x.status === 'blocked';
          const why = blocked ? `过不去：${x.reason}` : tired ? '体力不足' : null;
          return (
            <div className="w-row" key={x.id}>
              <div className="w-t">
                <strong>{x.visited ? x.name : `${x.name}（没去过）`}</strong>
                <small>
                  体力 −{x.stamina} · 约 {x.minutes} 分钟
                  {why ? ` · ${why}` : ''}
                </small>
              </div>
              <button className="w-btn primary" type="button" disabled={busy || tired || blocked} onClick={() => onMove(x.id)} aria-label={`前往${x.name}`}>
                前往
              </button>
            </div>
          );
        })}
        {exits.length > 0 && exits.every((x) => x.status === 'open' && player.stamina < x.stamina) && <p className="w-why">体力不足，先休息一下再赶路。</p>}
      </section>

      <section className="w-sec" aria-label="这里的人">
        <h4>这里的人</h4>
        {here.length === 0 ? (
          <p className="w-empty">这里没有别人。</p>
        ) : (
          here.map((n) => (
            <button className="w-row link" type="button" key={n.id} onClick={() => onOpenNpc(n.id)} aria-label={`查看${n.name}`}>
              <span className="w-t">
                <strong>
                  {n.name} · {n.role}
                </strong>
                <small>对你：{attitudeText(n.towardPlayer)}</small>
              </span>
              <span className="w-tag mute">查看</span>
            </button>
          ))
        )}
      </section>

      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
