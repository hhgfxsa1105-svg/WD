import { useEffect, useRef, useState } from 'react';
import { attributeScore, breakthroughChance, nextRealm, pillGradeOf, BREAKTHROUGH } from '@jhz/game-rules';
import type { InventoryItem, PlayerState } from '@jhz/contracts';
import { REALM_LABEL } from '../labels';
import { GradeTag } from './GradeTag';

interface Props {
  player: PlayerState;
  pills: InventoryItem[];
  busy: boolean;
  error: string | null;
  onConfirm: (pillItemId: string | null) => void;
  onClose: () => void;
}

const sign = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}%`;

export function BreakthroughModal({ player, pills, busy, error, onConfirm, onClose }: Props) {
  const [pillId, setPillId] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const target = nextRealm(player.realm);

  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  if (!target || player.realm === 'land_immortal') return null;
  const chance = breakthroughChance(player, pillId ? pillGradeOf(pillId) : null)!;
  const row = BREAKTHROUGH[player.realm];
  const score = Math.round(attributeScore(player.attributes) * 10) / 10;

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="btTitle">
        <h3 id="btTitle">
          突破{' '}
          <span>
            {REALM_LABEL[player.realm]} → {REALM_LABEL[target]}
          </span>
        </h3>

        <div className="rate">
          <dl>
            <div>
              <dt>基础成功率</dt>
              <dd>{chance.base}%</dd>
            </div>
            <div>
              <dt>
                属性加成（综合分 {score} / 要求 {row.requiredScore}）
              </dt>
              <dd>{sign(chance.attributeBonus)}</dd>
            </div>
            <div>
              <dt>丹药加成</dt>
              <dd>+{chance.pillBonus}%</dd>
            </div>
          </dl>
          <div className="total">
            <span>本次成功率</span>
            <b aria-live="polite">{chance.percent}%</b>
          </div>
          <div className="meter" aria-hidden="true">
            <i style={{ width: `${chance.percent}%` }} />
          </div>
        </div>

        <fieldset className="pills">
          <legend>丹药（可选，成败都会消耗）</legend>
          <label>
            <input type="radio" name="pill" checked={pillId === null} onChange={() => setPillId(null)} /> 不使用丹药
          </label>
          {pills.map((it) => (
            <label key={it.itemId} className={it.quantity > 0 ? '' : 'off'}>
              <input
                type="radio"
                name="pill"
                disabled={it.quantity <= 0}
                checked={pillId === it.itemId}
                onChange={() => setPillId(it.itemId)}
              />{' '}
              {it.name} <GradeTag grade={it.grade} />
              <span className="qty">×{it.quantity}</span>
            </label>
          ))}
        </fieldset>

        <p className="warn">失败：进度 −20、气血 −20%，需隔 24 小时才能再次突破；不会掉境界。</p>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button className="btn" type="button" ref={cancel} disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => onConfirm(pillId)}>
            确认突破
          </button>
        </div>
      </div>
    </div>
  );
}
