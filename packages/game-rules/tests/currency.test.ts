import { describe, expect, it } from 'vitest';
import type { Currency } from '@jhz/contracts';
import { canAfford, createSeededRng, earnCopper, exchange, spend, totalCopper } from '../src/index.js';

const c = (yuanbao: number, silver: number, copper: number): Currency => ({ yuanbao, silver, copper });

describe('货币换算', () => {
  it('1 元宝 = 100 银两 = 100000 铜钱', () => {
    expect(totalCopper(c(1, 0, 0))).toBe(100_000);
    expect(totalCopper(c(0, 1, 0))).toBe(1000);
    expect(totalCopper(c(1, 2, 3))).toBe(102_003);
  });

  it('余额判断：整数、非负、不超过总值', () => {
    expect(canAfford(c(0, 0, 100), 100)).toBe(true);
    expect(canAfford(c(0, 0, 100), 101)).toBe(false);
    expect(canAfford(c(0, 0, 100), -1)).toBe(false);
    expect(canAfford(c(0, 0, 100), 1.5)).toBe(false);
  });
});

describe('支付', () => {
  it('优先用铜钱，不足用银两并找零', () => {
    expect(spend(c(0, 2, 500), 300)).toEqual(c(0, 2, 200));
    expect(spend(c(0, 2, 100), 300)).toEqual(c(0, 1, 800)); // 付 1 银两，找零 700：100 + 700
  });

  it('银两不足时动用元宝并以小面额找零', () => {
    expect(spend(c(1, 0, 0), 1)).toEqual(c(0, 99, 999));
    expect(spend(c(1, 0, 0), 100_000)).toEqual(c(0, 0, 0));
    expect(spend(c(2, 1, 0), 150_000)).toEqual(c(0, 51, 0)); // 付 1 银两 + 2 元宝（20 万），找零 51000
  });

  it('余额不足或价格非法返回 null，且不改变入参', () => {
    const wallet = c(0, 1, 5);
    expect(spend(wallet, 1006)).toBeNull();
    expect(spend(wallet, -1)).toBeNull();
    expect(wallet).toEqual(c(0, 1, 5));
  });

  it('价格为 0 时不变', () => {
    expect(spend(c(1, 2, 3), 0)).toEqual(c(1, 2, 3));
  });

  it('性质：总价值守恒、各面额非负（随机 2000 组）', () => {
    const r = createSeededRng(2024);
    for (let i = 0; i < 2000; i++) {
      const w = c(Math.floor(r() * 5), Math.floor(r() * 300), Math.floor(r() * 3000));
      const price = Math.floor(r() * (totalCopper(w) + 500));
      const after = spend(w, price);
      if (price > totalCopper(w)) {
        expect(after).toBeNull();
      } else {
        expect(after).not.toBeNull();
        expect(totalCopper(after!) + price).toBe(totalCopper(w));
        expect(Math.min(after!.yuanbao, after!.silver, after!.copper)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('兑换与获得', () => {
  it('大换小、小换大（整数倍）', () => {
    expect(exchange(c(1, 0, 0), 'yuanbao', 'silver', 1)).toEqual(c(0, 100, 0));
    expect(exchange(c(0, 1, 0), 'silver', 'copper', 1)).toEqual(c(0, 0, 1000));
    expect(exchange(c(0, 0, 2000), 'copper', 'silver', 2000)).toEqual(c(0, 2, 0));
  });
  it('不整除、余额不足、同币种、非法数量均拒绝', () => {
    expect(exchange(c(0, 0, 1500), 'copper', 'silver', 1500)).toBeNull();
    expect(exchange(c(0, 50, 0), 'silver', 'yuanbao', 50)).toBeNull();
    expect(exchange(c(0, 0, 5), 'copper', 'silver', 10)).toBeNull();
    expect(exchange(c(1, 0, 0), 'yuanbao', 'yuanbao', 1)).toBeNull();
    expect(exchange(c(1, 0, 0), 'yuanbao', 'silver', 0)).toBeNull();
  });
  it('兑换不改变总价值', () => {
    const w = c(1, 7, 300);
    expect(totalCopper(exchange(w, 'silver', 'copper', 5)!)).toBe(totalCopper(w));
  });
  it('获得铜钱', () => {
    expect(earnCopper(c(0, 0, 1), 9)).toEqual(c(0, 0, 10));
  });
});
