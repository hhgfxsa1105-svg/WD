/** 共享数值与长度约束；前后端、规则与测试统一引用 */
export const LIMITS = {
  attribute: { min: 0, max: 9999 },
  progress: { min: 0, max: 100 },
  hpMax: 999_999,
  staminaMax: 9999,
  neiliMax: 99_999_999,
  currencyMax: 999_999_999,
  itemId: { max: 64 },
  idempotencyKey: { min: 8, max: 64 },
  freeInput: { min: 1, max: 200 },
  message: { max: 500 },
} as const;
