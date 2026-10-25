import { useEffect, useState } from 'react';
import type { NpcMemory, NpcView, PlayerState, RelationExplainResponse } from '@jhz/contracts';
import { fetchNpcMemories, fetchRelation } from '../api/client';
import { affinityBar, attitudeText, deltaText } from '../npc';

interface Props {
  npc: NpcView;
  player: PlayerState;
  busy: boolean;
  error: string | null;
  onGreet: (npcId: string) => Promise<unknown>;
}

function Meter({ label, value, tone, bar, shown }: { label: string; value: number; tone: string; bar: { left: number; width: number }; shown?: string }) {
  return (
    <div className="w-meter" style={{ ['--c' as string]: tone }} role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={-100} aria-valuemax={100}>
      <span>{label}</span>
      <i>
        <b style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
      </i>
      <span>{shown ?? value}</span>
    </div>
  );
}

export function NpcPanel({ npc, player, busy, error, onGreet }: Props) {
  const [mems, setMems] = useState<NpcMemory[] | null>(null);
  const [rel, setRel] = useState<RelationExplainResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const t = npc.towardPlayer;
  const stamp = `${npc.id}|${t.affinity}|${t.trust}|${t.hostility}`;

  // 人物或关系数值变化（如刚打过招呼）后重新读取记忆与关系来源
  useEffect(() => {
    let alive = true;
    setLoadErr(null);
    Promise.all([fetchNpcMemories(npc.id), fetchRelation(npc.id)]).then(
      ([m, r]) => {
        if (!alive) return;
        setMems(m);
        setRel(r);
      },
      () => alive && setLoadErr('读取人物的记忆失败，稍后再试。'),
    );
    return () => {
      alive = false;
    };
  }, [stamp, npc.id]);

  const here = npc.location.id === player.location.id;
  const met = (mems?.some((m) => m.type === 'met') ?? false) || (rel?.changes.some((c) => c.cause === '初次相识') ?? false);
  const disabled = busy || !here || met || mems === null;

  return (
    <>
      <div className="w-row">
        <div className="w-t">
          <strong>{npc.role}</strong>
          <small>{npc.intro}</small>
          {!here && <small className="w-why">现在在{npc.location.name}，你得先找过去。</small>}
        </div>
        <button className="w-btn primary" type="button" disabled={disabled} onClick={() => void onGreet(npc.id)}>
          {met ? '已相识' : '打招呼'}
        </button>
      </div>

      {npc.goals.length > 0 && <p className="w-sub">此刻在意的事：{npc.goals.join('、')}</p>}

      <section className="w-sec" aria-label="态度">
        <h4>他对你的态度<small>{attitudeText(t)}</small></h4>
        <Meter label="好感" value={t.affinity} tone="var(--good)" bar={affinityBar(t.affinity)} shown={t.affinity > 0 ? `+${t.affinity}` : String(t.affinity)} />
        <Meter label="信任" value={t.trust} tone="var(--neili)" bar={{ left: 0, width: t.trust }} />
        <Meter label="敌意" value={t.hostility} tone="var(--bad)" bar={{ left: 0, width: t.hostility }} />
      </section>

      <section className="w-sec" aria-label="他记得的事">
        <h4>他记得的事</h4>
        {loadErr ? (
          <p className="w-why" role="alert">
            {loadErr}
          </p>
        ) : mems === null ? (
          <p className="w-sub">正在回想…</p>
        ) : mems.length === 0 ? (
          <p className="w-sub">还没有。</p>
        ) : (
          <ul className="w-mem">
            {mems.map((m) => (
              <li key={m.id}>{m.summary}</li>
            ))}
          </ul>
        )}
      </section>

      {rel && (
        <details className="w-src">
          <summary>关系是怎么来的</summary>
          <div className="w-srcrows">
            <div>
              <span>初始</span>
              <span>
                好感 {rel.initial.affinity > 0 ? '+' : ''}
                {rel.initial.affinity} · 信任 {rel.initial.trust}
              </span>
            </div>
            {rel.changes.map((c) => (
              <div key={c.seq}>
                <span>{c.cause}</span>
                <span className="ok">{deltaText(c.delta)}</span>
              </div>
            ))}
            <div>
              <span>合计</span>
              <span className={rel.consistent ? 'ok' : 'bad'}>{rel.consistent ? '已核对 ✓' : '无法完整核对（有未记录的改动）'}</span>
            </div>
          </div>
        </details>
      )}

      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
