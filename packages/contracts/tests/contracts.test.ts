import { describe, expect, it } from 'vitest';
import {
  ErrorResponseSchema,
  LIMITS,
  PlayerStateSchema,
  SubmitActionRequestSchema,
} from '../src/index.js';

const validPlayer = {
  displayName: '无名侠客',
  level: 1,
  realm: 'mortal',
  hp: 100,
  maxHp: 100,
  stamina: 50,
  maxStamina: 50,
  silver: 10,
  attributes: { strength: 5, agility: 5, constitution: 5, comprehension: 5 },
  version: 0,
};

describe('PlayerStateSchema', () => {
  it('接受合法状态', () => {
    expect(PlayerStateSchema.safeParse(validPlayer).success).toBe(true);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['银两为负', { silver: -1 }],
    ['银两超上限', { silver: LIMITS.silverMax + 1 }],
    ['银两非整数', { silver: 1.5 }],
    ['hp 超过 maxHp', { hp: 101 }],
    ['stamina 超过 maxStamina', { stamina: 51 }],
    ['体力为负', { stamina: -1 }],
    ['未知境界', { realm: 'god' }],
    ['等级越界', { level: 0 }],
    ['未知字段', { cheat: true }],
    ['属性含未知键', { attributes: { ...validPlayer.attributes, luck: 99 } }],
    ['属性缺字段', { attributes: { strength: 1 } }],
    ['属性越界', { attributes: { ...validPlayer.attributes, strength: LIMITS.attribute.max + 1 } }],
    ['昵称为空白', { displayName: '   ' }],
    ['数值给字符串', { silver: '10' }],
  ];
  it.each(bad)('拒绝：%s', (_n, patch) => {
    expect(PlayerStateSchema.safeParse({ ...validPlayer, ...patch }).success).toBe(false);
  });

  it('拒绝缺字段', () => {
    const { silver: _s, ...rest } = validPlayer;
    expect(PlayerStateSchema.safeParse(rest).success).toBe(false);
  });
});

describe('SubmitActionRequestSchema', () => {
  const key = 'abcdefgh-1234';
  it('接受固定行动与自由输入', () => {
    expect(SubmitActionRequestSchema.safeParse({ kind: 'fixed', idempotencyKey: key, actionId: 'cultivate' }).success).toBe(true);
    expect(SubmitActionRequestSchema.safeParse({ kind: 'free', idempotencyKey: key, input: '去拜访掌门' }).success).toBe(true);
  });

  const bad: [string, unknown][] = [
    ['缺幂等键', { kind: 'fixed', actionId: 'rest' }],
    ['幂等键过短', { kind: 'fixed', idempotencyKey: 'abc', actionId: 'rest' }],
    ['幂等键含非法字符', { kind: 'fixed', idempotencyKey: 'abcdefgh!;--', actionId: 'rest' }],
    ['未知固定行动', { kind: 'fixed', idempotencyKey: key, actionId: 'steal' }],
    ['自由输入为空白', { kind: 'free', idempotencyKey: key, input: '   ' }],
    ['自由输入超长', { kind: 'free', idempotencyKey: key, input: 'a'.repeat(LIMITS.freeInput.max + 1) }],
    ['携带前端指定数值', { kind: 'fixed', idempotencyKey: key, actionId: 'rest', silver: 9999 }],
    ['未知 kind', { kind: 'sql', idempotencyKey: key }],
    ['非对象', 'rest'],
  ];
  it.each(bad)('拒绝：%s', (_n, body) => {
    expect(SubmitActionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('ErrorResponseSchema', () => {
  it('接受标准错误并拒绝多余字段（如堆栈）', () => {
    const ok = { code: 'VALIDATION_FAILED', message: 'x', request_id: 'r1' };
    expect(ErrorResponseSchema.safeParse(ok).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ ...ok, stack: 'at ...' }).success).toBe(false);
  });
});
