import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // 随机序列 / 重放 / 性能护栏类用例要走几百步真实数据库操作，单条约 4–5 秒，默认 5 秒的超时会让并行跑时偶发失败；
    // 这里给足余量（真正的性能阈值由用例内的断言守住，不靠超时）
    testTimeout: 30_000,
  },
});
