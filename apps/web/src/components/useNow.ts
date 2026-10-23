import { useEffect, useState } from 'react';

/** 每秒更新的「服务端时间」（本机时间 + 偏移），用于冷却与放置修炼的倒计时显示 */
export function useNow(offsetMs: number, active = true): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setTick(Date.now());
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return tick + offsetMs;
}
