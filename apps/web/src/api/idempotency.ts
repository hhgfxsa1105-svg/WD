import { newIdempotencyKey } from './client';

/**
 * 幂等键仓库：同一个操作在「网络失败（不确定服务端是否已处理）」后重试时复用原键，
 * 避免请求其实已成功却被当成新请求而重复结算（如重复扣丹药）；
 * 成功或收到明确的服务端拒绝后清除，下次操作使用新键。
 */
export function createKeyStore(makeKey: () => string = newIdempotencyKey) {
  const keys = new Map<string, string>();
  return {
    keyFor(fingerprint: string): string {
      let k = keys.get(fingerprint);
      if (!k) {
        k = makeKey();
        keys.set(fingerprint, k);
      }
      return k;
    },
    clear(fingerprint: string): void {
      keys.delete(fingerprint);
    },
  };
}
