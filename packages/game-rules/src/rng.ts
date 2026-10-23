/** 随机源：返回 [0, 1) 的数。规则函数一律通过参数注入，测试可固定种子 */
export type Rng = () => number;

/** mulberry32：确定性伪随机，相同种子产生相同序列（仅用于测试与可复现场景，不用于线上结算） */
export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 固定序列，序列耗尽后重复最后一个值；便于精确构造边界用例 */
export function fixedRng(...values: number[]): Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}
