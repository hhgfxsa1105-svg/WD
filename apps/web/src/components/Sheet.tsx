import type { ReactNode } from 'react';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-head">
        <h3>{title}</h3>
        <button type="button" onClick={onClose}>
          收起
        </button>
      </div>
      {children}
    </div>
  );
}
