import { describe, expect, it } from 'vitest';
import { createSeededRng, fixedRng } from '../src/index.js';

describe('随机源', () => {
  it('相同种子产生相同序列，不同种子不同', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const c = createSeededRng(43);
    const sa = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(sa);
    expect(Array.from({ length: 20 }, c)).not.toEqual(sa);
  });

  it('输出范围 [0,1)，分布大致均匀', () => {
    const r = createSeededRng(7);
    const xs = Array.from({ length: 10000 }, r);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });

  it('固定序列耗尽后重复最后一个值', () => {
    const r = fixedRng(0.1, 0.9);
    expect([r(), r(), r()]).toEqual([0.1, 0.9, 0.9]);
  });
});
