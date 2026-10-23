import { RULES } from '@jhz/game-rules';
import type { CultivationJob, PlayerState } from '@jhz/contracts';
import { breakthroughView } from '../breakthrough';
import { idlePreview } from '../idle';
import { useNow } from './useNow';

interface Props {
  player: PlayerState;
  job: CultivationJob | null;
  serverOffset: number;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onStartIdle: () => void;
  onSettleIdle: () => void;
  onStopIdle: () => void;
  onCultivate: () => void;
  onRest: () => void;
  onOpenBreakthrough: () => void;
}

export function ActionPanel(p: Props) {
  const now = useNow(p.serverOffset);
  const bt = breakthroughView(p.player, now);
  const canCultivate = p.player.stamina >= RULES.cultivate.staminaCost;
  const preview = p.job ? idlePreview(p.player, p.job, now) : null;
  const full = p.player.realmProgress >= 100;

  return (
    <>
      <section className="sec" aria-label="放置修炼">
        <h4>放置修炼</h4>
        {p.job && preview ? (
          <div className="row">
            <div className="info">
              修炼中
              <small>
                已累计 {preview.minutes} 分钟 · 可领取约 +{preview.progressGain}% 经验
              </small>
            </div>
            <div className="btns">
              <button className="btn" type="button" disabled={p.busy} onClick={p.onSettleIdle}>
                领取收益
              </button>
              <button className="btn" type="button" disabled={p.busy} onClick={p.onStopIdle}>
                停止
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <div className="info">
              未在修炼
              <small>{full ? '修炼已圆满，请先尝试突破' : '开启后离线也会累积，按服务端时间结算'}</small>
            </div>
            <button className="btn primary" type="button" disabled={p.busy || full} onClick={p.onStartIdle}>
              开始放置修炼
            </button>
          </div>
        )}
      </section>

      <section className="sec" aria-label="固定行动">
        <h4>固定行动</h4>
        <div className="acts">
          <button className="act" type="button" disabled={p.busy || !canCultivate} onClick={p.onCultivate}>
            <strong>修炼</strong>
            <span>体力 −{RULES.cultivate.staminaCost} · 获得经验</span>
          </button>
          <button className="act" type="button" disabled={p.busy} onClick={p.onRest}>
            <strong>休息</strong>
            <span>
              体力 +{RULES.rest.staminaGain} · 气血 +{RULES.rest.hpGain}
            </span>
          </button>
        </div>
      </section>

      <section className="sec" aria-label="突破">
        <h4>突破</h4>
        <button className={`act bt${bt.ok ? ' ready' : ''}`} type="button" disabled={p.busy || !bt.ok} onClick={p.onOpenBreakthrough}>
          <strong>突破{bt.route ? ` · ${bt.route}` : ''}</strong>
          <span>{bt.text}</span>
        </button>
      </section>

      <form className="free" onSubmit={(e) => e.preventDefault()}>
        <input type="text" maxLength={200} placeholder="自由行动将在 AI 接入后开放（S3）" disabled aria-label="自由行动输入" />
        <button type="submit" disabled>
          行动
        </button>
      </form>

      {p.error ? (
        <p className="err" role="alert">
          {p.error}
        </p>
      ) : p.notice ? (
        <p className="soon" role="status">
          {p.notice}
        </p>
      ) : (
        !canCultivate && <p className="soon">体力不足，先休息一下再修炼。</p>
      )}
    </>
  );
}
