import type { Rng } from '@jhz/game-rules';

/** 服务端权威时钟；测试注入可控时钟 */
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** 线上结算用的安全随机源（测试通过注入固定随机源替换） */
export const secureRng: Rng = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;
