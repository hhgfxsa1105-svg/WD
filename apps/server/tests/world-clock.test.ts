import { describe, expect, it } from 'vitest';
import { WorldTimeResponseSchema } from '@jhz/contracts';
import { buildApp } from '../src/app.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { WorldClock } from '../src/shared/world-clock.js';
import type { ClockPersistence } from '../src/modules/store/types.js';

const mem = (initial: number | null = null): ClockPersistence & { value: number | null; saves: number } => {
  const s = {
    value: initial,
    saves: 0,
    load: () => s.value,
    save: (t: number) => {
      s.value = Math.max(s.value ?? 0, t);
      s.saves++;
    },
  };
  return s;
};
const T0 = 1_800_000_000_000;

describe('WorldClock', () => {
  it('正常情况下等于系统时间', () => {
    let wall = T0;
    const c = new WorldClock(mem(), { wall: () => wall });
    expect(c.now()).toBe(T0);
    wall += 5000;
    expect(c.now()).toBe(T0 + 5000);
    expect(c.behindMs()).toBe(0);
  });

  it('系统时间被调到过去：世界时间停在高水位，追平后继续', () => {
    let wall = T0;
    const seen: number[] = [];
    const c = new WorldClock(mem(), { wall: () => wall, onRegression: (b) => seen.push(b) });
    wall += 10_000;
    expect(c.now()).toBe(T0 + 10_000);
    wall = T0 - 3_600_000; // 调早 1 小时多
    expect(c.now()).toBe(T0 + 10_000); // 不倒退
    expect(c.behindMs()).toBe(3_610_000);
    expect(seen.at(-1)).toBe(3_610_000);
    wall = T0 + 20_000; // 追平并超过
    expect(c.now()).toBe(T0 + 20_000);
    expect(c.behindMs()).toBe(0);
  });

  it('重启后系统时间比上次记录还早：沿用持久化的高水位', () => {
    const store = mem();
    let wall = T0;
    const a = new WorldClock(store, { wall: () => wall });
    wall += 60_000;
    a.now();
    a.flush();

    wall = T0 - 86_400_000; // 重启前把系统时间调早一天
    const b = new WorldClock(store, { wall: () => wall });
    expect(b.now()).toBe(T0 + 60_000);
    expect(b.behindMs()).toBeGreaterThan(86_000_000);
  });

  it('重启后系统时间正常前进：接受（视为离线），不冻结', () => {
    const store = mem(T0);
    const c = new WorldClock(store, { wall: () => T0 + 30 * 3_600_000 });
    expect(c.now()).toBe(T0 + 30 * 3_600_000);
  });

  it('高水位写入被限流，flush 强制写入', () => {
    const store = mem();
    let wall = T0;
    const c = new WorldClock(store, { wall: () => wall, saveEveryMs: 60_000 });
    const base = store.saves;
    for (let i = 0; i < 50; i++) {
      wall += 1000;
      c.now();
    }
    expect(store.saves - base).toBe(0); // 50 秒内不写
    wall += 20_000;
    c.now();
    expect(store.saves - base).toBe(1);
    c.flush();
    expect(store.value).toBe(wall);
  });
});

describe('回拨系统时间不能让收益或冷却被重复计入', () => {
  it('放置修炼：时间回拨后不产生收益，也不倒退；追平后才继续计入', async () => {
    let wall = T0;
    const store = createMemoryGameStore();
    const clock = new WorldClock(store.worldClock, { wall: () => wall });
    const app = await buildApp({ store, clock, offline: { thresholdMs: Number.MAX_SAFE_INTEGER } });
    const post = (p: string) => app.inject({ method: 'POST', url: `/api/v1/cultivation/${p}` });
    const progress = () => store.read((tx) => tx.player().realmProgress);

    await post('start');
    wall = T0 + 10 * 60_000;
    await post('settle');
    expect(progress()).toBe(2);

    wall = T0 - 24 * 3_600_000; // 调早一天，再「继续修炼」
    await post('settle');
    wall = T0 + 5 * 60_000; // 仍早于已记录的时间
    await post('settle');
    expect(progress()).toBe(2); // 没有任何额外收益

    wall = T0 + 20 * 60_000; // 追平后继续
    await post('settle');
    expect(progress()).toBeGreaterThan(2);
  });

  it('世界时间接口：返回服务端时间、离线规则与回拨状态', async () => {
    let wall = T0;
    const store = createMemoryGameStore();
    const clock = new WorldClock(store.worldClock, { wall: () => wall });
    const app = await buildApp({ store, clock, clockBehindMs: () => clock.behindMs() });
    const get = async () => WorldTimeResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/world/time' })).json());

    const a = await get();
    expect(a.serverNow).toBe(T0);
    expect(a.offline).toEqual({ thresholdMs: 5 * 60_000, capMs: 12 * 3_600_000, efficiencyPercent: 50 });
    expect(a.clockBehindMs).toBe(0);

    wall = T0 - 90_000;
    const b = await get();
    expect(b.serverNow).toBe(T0);
    expect(b.clockBehindMs).toBe(90_000);
  });
});
