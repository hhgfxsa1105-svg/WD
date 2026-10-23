import { COSTS } from '../mock/engine';

interface Props {
  canCultivate: boolean;
  onCultivate: () => void;
  onRest: () => void;
}

export function ActionPanel({ canCultivate, onCultivate, onRest }: Props) {
  return (
    <>
      <div className="acts">
        <button className="act" type="button" disabled={!canCultivate} onClick={onCultivate}>
          <strong>修炼</strong>
          <span>体力 −{COSTS.CULTIVATE_COST} · 获得经验</span>
        </button>
        <button className="act" type="button" onClick={onRest}>
          <strong>休息</strong>
          <span>
            体力 +{COSTS.REST_STAMINA} · 气血 +{COSTS.REST_HP}
          </span>
        </button>
      </div>
      <form className="free" style={{ marginTop: 10 }} onSubmit={(e) => e.preventDefault()}>
        <input type="text" maxLength={200} placeholder="自由行动将在 AI 接入后开放（S3）" disabled aria-label="自由行动输入" />
        <button type="submit" disabled>
          行动
        </button>
      </form>
      {!canCultivate && <p className="soon">体力不足，先休息一下。</p>}
    </>
  );
}
