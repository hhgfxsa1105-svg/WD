import { useEffect, useRef, useState } from 'react';
import type { AiView } from '../ai';
import type { LogEntry } from '../log';

interface Props {
  entries: LogEntry[];
  ai: AiView;
  /** 重试叙事；成功返回 null，失败返回原因 */
  onRetryNarration: (actionId: string) => Promise<string | null>;
}

export function LogPanel({ entries, ai, onRetryNarration }: Props) {
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const retry = async (actionId: string) => {
    setRetrying((s) => new Set(s).add(actionId));
    setFailed(({ [actionId]: _drop, ...rest }) => rest);
    const err = await onRetryNarration(actionId);
    setRetrying((s) => {
      const n = new Set(s);
      n.delete(actionId);
      return n;
    });
    if (err) setFailed((f) => ({ ...f, [actionId]: err }));
  };
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <section className="log-wrap" aria-label="日志">
      <div className="log-head">
        <span className="label">日志</span>
        <span className="head-right">
          <span className="ai-dot" data-s={ai.state} role="status">
            <i aria-hidden="true" />
            {ai.label}
          </span>
          <span className="label">{entries.length} 条</span>
        </span>
      </div>
      <ol className="log" ref={list} aria-live="polite">
        {entries.map((e) => (
          <li className={e.system ? 'entry system' : 'entry'} key={e.key}>
            <time>{e.time}</time>
            <div>
              <p>{e.text}</p>
              {e.chips.length > 0 && (
                <div className="delta">
                  {e.chips.map((c) => (
                    <span className={`chip ${c.tone}`} key={c.text}>
                      {c.text}
                    </span>
                  ))}
                </div>
              )}
              {e.sub && <div className="sub">{e.sub}</div>}
              {e.pendingNarration && (
                <div className="pending">
                  <span className="tag">叙事待补</span>
                  <span>结果已生效，文字为简写</span>
                  <button className="linkbtn" type="button" disabled={retrying.has(e.pendingNarration.actionId)} onClick={() => retry(e.pendingNarration!.actionId)}>
                    {retrying.has(e.pendingNarration.actionId) ? '生成中…' : '重新叙事'}
                  </button>
                  {failed[e.pendingNarration.actionId] && (
                    <span className="fail" role="alert">
                      {failed[e.pendingNarration.actionId]}
                    </span>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
