import type { ReactNode } from 'react';

interface Props {
  unreadMessages: boolean;
  onOpen: (name: string) => void;
}

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
);

const ITEMS: { name: string; icon: ReactNode; gap?: boolean }[] = [
  {
    name: '设置',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>,
    ),
  },
  {
    name: '任务',
    gap: true,
    icon: icon(
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>,
    ),
  },
  {
    name: '消息',
    gap: true,
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>,
    ),
  },
];

export function SideRail({ unreadMessages, onOpen }: Props) {
  return (
    <nav className="rail" aria-label="功能入口">
      {ITEMS.map((it) => (
        <button
          key={it.name}
          type="button"
          aria-label={it.name}
          style={it.gap ? { marginTop: 12 } : undefined}
          onClick={() => onOpen(it.name)}
        >
          {it.icon}
          <span className="tip">{it.name}</span>
          {it.name === '消息' && unreadMessages && <i className="badge" />}
        </button>
      ))}
    </nav>
  );
}
