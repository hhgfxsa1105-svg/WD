/** 共享数值与长度约束；前后端、规则与测试统一引用 */
export const LIMITS = {
  level: { min: 1, max: 999 },
  attribute: { min: 0, max: 9999 },
  hpMax: 999_999,
  staminaMax: 9999,
  silverMax: 999_999_999,
  idempotencyKey: { min: 8, max: 64 },
  freeInput: { min: 1, max: 200 },
  message: { max: 500 },
} as const;
