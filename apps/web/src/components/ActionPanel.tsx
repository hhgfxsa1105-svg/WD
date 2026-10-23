import { RULES } from '@jhz/game-rules';

interface Props {
  busy: boolean;
  canCultivate: boolean;
  error: string | null;
  onCultivate: () => void;
  onRest: () => void;
}

export function ActionPanel({ busy, canCultivate, error, onCultivate, onRest }: Props) {
  return (
    <>
      <div className="acts">
        <button className="act" type="button" disabled={busy || !canCultivate} onClick={onCultivate}>
          <strong>修炼</strong>
          <span>体力 −{RULES.cultivate.staminaCost} · 获得经验</span>
        </button>
        <button className="act" type="button" disabled={busy} onClick={onRest}>
          <strong>休息</strong>
          <span>
            体力 +{RULES.rest.staminaGain} · 气血 +{RULES.rest.hpGain}
          </span>
        </button>
      </div>
      <form className="free" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <input type="text" maxLength={200} placeholder="自由行动将在 AI 接入后开放（S3）" disabled aria-label="自由行动输入" />
        <button type="submit" disabled>
          行动
        </button>
      </form>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : (
        !canCultivate && <p className="soon">体力不足，先休息一下。</p>
      )}
    </>
  );
}
