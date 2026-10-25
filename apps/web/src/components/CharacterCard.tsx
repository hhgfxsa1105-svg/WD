import { useEffect, useRef, useState } from 'react';
import { realmHasNeili, type Honorific, type PlayerState } from '@jhz/contracts';
import { ATTRIBUTE_ORDER, REALM_LABEL } from '../labels';
import { GradeTag } from './GradeTag';

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <i style={{ width: `${(value / max) * 100}%`, ['--c' as string]: color }} />
      </div>
      <b>
        {value}/{max}
      </b>
    </div>
  );
}

const ROWS: { label: string; key: 'title' | 'epithet' | 'fate' }[] = [
  { label: '头衔', key: 'title' },
  { label: '称号', key: 'epithet' },
  { label: '命格', key: 'fate' },
];

export function CharacterCard({ player: p }: { player: PlayerState }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <section className="card" aria-label="角色">
      <div className="id-row">
        <div ref={box}>
          <button className="title" type="button" aria-expanded={open} aria-controls="namePop" onClick={() => setOpen((v) => !v)}>
            {p.displayName}
          </button>
          <span className="tag">
            <i>头衔</i>
            {p.title ? p.title.name : '无'}
            {p.title && <GradeTag grade={p.title.grade} />}
          </span>
          {open && (
            <div className="pop" id="namePop">
              {ROWS.map(({ label, key }) => {
                const h = p[key];
                return (
                  <div className="row" key={key}>
                    <i>{label}</i>
                    <b>{h ? h.name : '无'}</b>
                    {h && <GradeTag grade={h.grade} />}
                    {h && h.effects.length > 0 && <p>{h.effects.map((e) => e.text).join('；')}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="right">
          <span className="money">
            <span>
              <i>元宝</i>
              <b>{p.currency.yuanbao}</b>
            </span>
            <span>
              <i>银两</i>
              <b>{p.currency.silver}</b>
            </span>
            <span>
              <i>铜钱</i>
              <b>{p.currency.copper}</b>
            </span>
          </span>
          <span className="realm">{REALM_LABEL[p.realm]}</span>
          <span className="xp" role="progressbar" aria-label="晋级进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.realmProgress}>
            <i style={{ width: `${p.realmProgress}%` }} />
          </span>
        </div>
      </div>

      <dl className="six" aria-label="六维">
        {ATTRIBUTE_ORDER.map(({ key, label }) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{p.attributes[key]}</dd>
          </div>
        ))}
      </dl>

      <div className="bars">
        <Bar label="气血" value={p.hp} max={p.maxHp} color="var(--hp)" />
        <Bar label="体力" value={p.stamina} max={p.maxStamina} color="var(--stamina)" />
        {p.neili && realmHasNeili(p.realm) && <Bar label="内力" value={p.neili.current} max={p.neili.max} color="var(--neili)" />}
      </div>
    </section>
  );
}
