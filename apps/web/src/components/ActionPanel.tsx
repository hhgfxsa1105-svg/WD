import { useEffect, useState, type FormEvent } from 'react';
import { RULES } from '@jhz/game-rules';
import type { ActionResponse, CultivationJob, PlayerState, WorldTimeResponse } from '@jhz/contracts';
import { FREE_HINTS, SLOW_MS, type AiView } from '../ai';
import type { AiReply } from '../useGame';
import { breakthroughView } from '../breakthrough';
import { idlePreview } from '../idle';
import { offlineRuleText } from '../offline';
import { formatDuration } from '../time';
import { useNow } from './useNow';

interface Props {
  player: PlayerState;
  job: CultivationJob | null;
  serverOffset: number;
  world: WorldTimeResponse | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onStartIdle: () => void;
  onSettleIdle: () => void;
  onStopIdle: () => void;
  onCultivate: () => void;
  onRest: () => void;
  onOpenBreakthrough: () => void;
  ai: AiView;
  thinking: boolean;
  aiReply: AiReply | null;
  /** 提交自由行动；返回服务端结果，失败返回 null */
  onFree: (input: string) => Promise<ActionResponse | null>;
}

export function ActionPanel(p: Props) {
  const now = useNow(p.serverOffset);
  const bt = breakthroughView(p.player, p.world?.game.minutes ?? 0);
  const canCultivate = p.player.stamina >= RULES.cultivate.staminaCost;
  const preview = p.job ? idlePreview(p.player, p.job, now) : null;
  const full = p.player.realmProgress >= 100;
  const [text, setText] = useState('');
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!p.thinking) return setSlow(false);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [p.thinking]);
  const canSend = p.ai.canInput && !p.busy && text.trim().length > 0;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    const r = await p.onFree(text.trim());
    if (r?.ai?.executed) setText(''); // 已执行才清空；澄清、失败时保留，方便改几个字重发
  };

  return (
    <>
      <section className="sec" aria-label="自由行动">
        <h4>
          自由行动<small>{text.length}/200</small>
        </h4>
        <form className="free" onSubmit={send}>
          <input
            id="free-input"
            type="text"
            maxLength={200}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={p.ai.canInput ? '想做什么？比如：打坐一会儿' : (p.ai.reason ?? 'AI 暂不可用')}
            disabled={!p.ai.canInput || p.thinking}
            aria-label="自由行动输入"
          />
          <button type="submit" disabled={!canSend}>
            {p.thinking ? '处理中' : '行动'}
          </button>
        </form>
        {p.ai.canInput && (
          <div className="hints">
            {FREE_HINTS.map((h) => (
              <button key={h} type="button" className="hint" disabled={p.thinking} onClick={() => setText(h)}>
                {h}
              </button>
            ))}
          </div>
        )}
        {p.thinking ? (
          <div className="reply" role="status">
            <span className="l">{slow ? 'AI 有点慢，可以继续等，或改用固定行动' : '正在理解你的意思'}</span>
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : p.aiReply ? (
          <div className={`reply ${p.aiReply.tone}`} role="status">
            <span className="l">{p.aiReply.label}</span>
            {p.aiReply.text}
          </div>
        ) : (
          !p.ai.canInput && (
            <div className="reply warn" role="status">
              {p.ai.reason}
            </div>
          )
        )}
      </section>

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

      {p.world && (
        <p className="soon rule" aria-label="离线规则">
          {offlineRuleText(p.world.offline.capMs, p.world.offline.efficiencyPercent)}
        </p>
      )}
      {p.world && p.world.clockBehindMs > 0 && (
        <p className="err" role="alert">
          检测到系统时间早于游戏时间 {formatDuration(p.world.clockBehindMs)}，游戏时间已暂停，待系统时间追平后继续。
        </p>
      )}

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
