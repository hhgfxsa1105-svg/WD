export const NAV_ITEMS = ['背包', '功法', '地图', '行动'] as const;

export function BottomNav({ active, onOpen }: { active: string | null; onOpen: (name: string) => void }) {
  return (
    <div className="nav-wrap">
      <div className="pill" role="group" aria-label="主导航">
        {NAV_ITEMS.map((n) => (
          <button key={n} type="button" aria-pressed={active === n} onClick={() => onOpen(n)}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
