import type { QuestOp, QuestView } from '@jhz/contracts';
import { currentStep, questStatusLabel } from '../npc';

interface Props {
  quests: QuestView[];
  busy: boolean;
  error: string | null;
  onOp: (questId: string, op: QuestOp) => void;
}

export function QuestPanel({ quests, busy, error, onOp }: Props) {
  if (quests.length === 0) return <p className="w-empty">暂时没有任务。</p>;
  return (
    <>
      {quests.map((q) => {
        const cur = currentStep(q);
        const done = q.status === 'completed';
        return (
          <article className="w-quest" key={q.id} aria-label={q.name}>
            <header>
              <strong>{q.name}</strong>
              <span className={`w-tag${done && q.claimed ? ' good' : q.status === 'locked' || q.status === 'failed' ? ' mute' : ''}`}>{questStatusLabel(q)}</span>
            </header>
            <p className="w-sub">
              {q.summary}
              {q.giver ? ` · ${q.giver}` : ''}
            </p>
            <ul className="w-steps">
              {q.steps.map((s, i) => (
                <li key={s.text} className={`${s.done ? 'done' : ''}${i === cur ? ' now' : ''}`}>
                  {s.text}
                </li>
              ))}
            </ul>
            <footer>
              {q.status === 'locked' ? (
                <span className="w-why">需要先完成「{q.lockedBy}」</span>
              ) : (
                <span className="w-sub">奖励：{q.reward.join(' · ') || '无'}</span>
              )}
              {q.status === 'available' && (
                <button className="w-btn primary" type="button" disabled={busy} onClick={() => onOp(q.id, 'accept')}>
                  接取
                </button>
              )}
              {q.status === 'locked' && (
                <button className="w-btn" type="button" disabled>
                  接取
                </button>
              )}
              {done && !q.claimed && (
                <button className="w-btn primary" type="button" disabled={busy} onClick={() => onOp(q.id, 'claim')}>
                  领取奖励
                </button>
              )}
              {q.status === 'active' && (
                <button className="w-btn" type="button" disabled={busy} onClick={() => onOp(q.id, 'abandon')}>
                  放弃
                </button>
              )}
            </footer>
          </article>
        );
      })}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
