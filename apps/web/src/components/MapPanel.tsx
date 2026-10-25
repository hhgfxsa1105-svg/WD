import type { NpcView, PlayerState } from '@jhz/contracts';
import { LOCATION_DEFS, MOVE_STAMINA_COST, isLocationId, neighborsOf } from '@jhz/game-rules';
import { attitudeText } from '../npc';

interface Props {
  player: PlayerState;
  npcs: NpcView[];
  busy: boolean;
  error: string | null;
  onMove: (locationId: string) => void;
  onOpenNpc: (npcId: string) => void;
}

export function MapPanel({ player, npcs, busy, error, onMove, onOpenNpc }: Props) {
  const here = npcs.filter((n) => n.location.id === player.location.id);
  const tired = player.stamina < MOVE_STAMINA_COST;
  const next = neighborsOf(player.location.id);

  return (
    <>
      <section className="w-sec" aria-label="能去的地方">
        <h4>
          能去的地方<small>每次前往 体力 −{MOVE_STAMINA_COST}</small>
        </h4>
        {next.map((id) => (
          <div className="w-row" key={id}>
            <div className="w-t">
              <strong>{isLocationId(id) ? LOCATION_DEFS[id].name : id}</strong>
            </div>
            <button className="w-btn primary" type="button" disabled={busy || tired} onClick={() => onMove(id)} aria-label={`前往${isLocationId(id) ? LOCATION_DEFS[id].name : id}`}>
              前往
            </button>
          </div>
        ))}
        {tired && <p className="w-why">体力不足，先休息一下再赶路。</p>}
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
