import type { LocationRef } from '@jhz/contracts';

export function LocationBar({ location, time }: { location: LocationRef; time: string }) {
  return (
    <div className="loc">
      <div className="where">
        <span>位置</span>
        <strong>{location.name}</strong>
      </div>
      <span>{time}</span>
    </div>
  );
}
