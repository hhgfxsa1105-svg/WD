import { useEffect, useRef } from 'react';
import type { LogEntry } from '../log';

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <section className="log-wrap" aria-label="日志">
      <div className="log-head">
        <span className="label">日志</span>
        <span className="label">{entries.length} 条</span>
      </div>
      <ol className="log" ref={list} aria-live="polite">
        {entries.map((e) => (
          <li className={e.system ? 'entry system' : 'entry'} key={e.id}>
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
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
