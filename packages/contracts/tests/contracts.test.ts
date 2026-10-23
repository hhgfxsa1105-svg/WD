import { describe, expect, it } from 'vitest';
import {
  AuditEventSchema,
  ErrorResponseSchema,
  LIMITS,
  LogRecordSchema,
  PlayerStateSchema,
  REALMS,
  SubmitActionRequestSchema,
  realmHasNeili,
} from '../src/index.js';

const honor = (grade = 'fan') => ({
  id: 'h_1',
  name: '山门弟子',
  grade,
  effects: [{ kind: 'exp_multiplier', value: 5, text: '修炼经验 +5%' }],
});

const validPlayer = {
  displayName: '林惊鸿',
  realm: 'body_tempering',
  realmProgress: 0,
  hp: 100,
  maxHp: 100,
  stamina: 50,
  maxStamina: 50,
  neili: null,
  currency: { yuanbao: 0, silver: 10, copper: 320 },
  attributes: { spirit: 5, strength: 5, agility: 5, constitution: 5, comprehension: 5, fortune: 5 },
  title: honor(),
  epithet: honor(),
  fate: honor('xuan'),
  location: { id: 'loc_qingyun_gate', name: '青云山 · 山门' },
  breakthroughAvailableAt: null,
  version: 0,
};

describe('PlayerStateSchema', () => {
  it('接受合法状态（炼体无内力）', () => {
    expect(PlayerStateSchema.safeParse(validPlayer).success).toBe(true);
  });

  it('后天及以上必须有内力，且名号可为空', () => {
    const p = {
      ...validPlayer,
      realm: 'houtian',
      neili: { current: 10, max: 60 },
      title: null,
      epithet: null,
      fate: null,
    };
    expect(PlayerStateSchema.safeParse(p).success).toBe(true);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['炼体却有内力', { neili: { current: 0, max: 10 } }],
    ['后天却无内力', { realm: 'houtian', neili: null }],
    ['内力超过上限', { realm: 'houtian', neili: { current: 11, max: 10 } }],
    ['铜钱为负', { currency: { yuanbao: 0, silver: 0, copper: -1 } }],
    ['元宝超上限', { currency: { yuanbao: LIMITS.currencyMax + 1, silver: 0, copper: 0 } }],
    ['银两非整数', { currency: { yuanbao: 0, silver: 1.5, copper: 0 } }],
    ['货币缺字段', { currency: { silver: 1 } }],
    ['货币含未知币种', { currency: { yuanbao: 0, silver: 0, copper: 0, gold: 1 } }],
    ['进度超过 100', { realmProgress: 101 }],
    ['hp 超过 maxHp', { hp: 101 }],
    ['stamina 超过 maxStamina', { stamina: 51 }],
    ['体力为负', { stamina: -1 }],
    ['未知境界', { realm: 'god' }],
    ['旧境界名', { realm: 'mortal' }],
    ['未知字段', { cheat: true }],
    ['携带隐藏属性 charm', { charm: 99 }],
    ['属性含魅力', { attributes: { ...validPlayer.attributes, charm: 99 } }],
    ['属性缺字段', { attributes: { spirit: 1 } }],
    ['属性越界', { attributes: { ...validPlayer.attributes, strength: LIMITS.attribute.max + 1 } }],
    ['未知评级', { title: honor('legend') }],
    ['名号效果类别未知', { title: { ...honor(), effects: [{ kind: 'god_mode', value: 1, text: 'x' }] } }],
    ['名号效果缺数值', { title: { ...honor(), effects: [{ kind: 'exp_multiplier', text: 'x' }] } }],
    ['名号效果数值越界', { title: { ...honor(), effects: [{ kind: 'exp_multiplier', value: 5000, text: 'x' }] } }],
    ['名号含未知字段', { title: { ...honor(), power: 9999 } }],
    ['冷却时间为负', { breakthroughAvailableAt: -1 }],
    ['冷却时间非整数', { breakthroughAvailableAt: 1.5 }],
    ['缺冷却字段不可省略', { breakthroughAvailableAt: undefined }],
    ['位置缺 id', { location: { name: '山门' } }],
    ['昵称为空白', { displayName: '   ' }],
    ['数值给字符串', { hp: '10' }],
  ];
  it.each(bad)('拒绝：%s', (_n, patch) => {
    expect(PlayerStateSchema.safeParse({ ...validPlayer, ...patch }).success).toBe(false);
  });

  it('拒绝缺字段', () => {
    const { currency: _c, ...rest } = validPlayer;
    expect(PlayerStateSchema.safeParse(rest).success).toBe(false);
  });
});

describe('realmHasNeili', () => {
  it('仅后天及以上有内力', () => {
    expect(REALMS.map(realmHasNeili)).toEqual([false, false, true, true, true, true, true]);
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

describe('LogRecordSchema / AuditEventSchema', () => {
  const log = {
    id: 1,
    at: 1000,
    type: 'breakthrough',
    narrative: '突破',
    changes: [{ stat: 'hp', delta: -20 }],
    breakthrough: { outcome: 'failure', chancePercent: 70, roll: 90.5, pillName: null, realmFrom: 'body_tempering', realmTo: 'body_tempering' },
    idle: null,
    note: null,
  };
  it('接受合法日志记录', () => {
    expect(LogRecordSchema.safeParse(log).success).toBe(true);
  });
  it.each([
    ['序号为 0', { id: 0 }],
    ['未知类型', { type: 'chat' }],
    ['未知字段', { secret: 1 }],
    ['成功率越界', { breakthrough: { ...log.breakthrough, chancePercent: 101 } }],
    ['掷点为负', { breakthrough: { ...log.breakthrough, roll: -1 } }],
    ['未知境界', { breakthrough: { ...log.breakthrough, realmTo: 'god' } }],
    ['缺 note', { note: undefined }],
  ])('拒绝日志：%s', (_n, patch) => {
    expect(LogRecordSchema.safeParse({ ...log, ...patch }).success).toBe(false);
  });

  const ev = { seq: 1, id: 'e1', actorId: 'player_1', actionId: null, eventType: 'cultivation.start', before: null, after: { cultivation: 'running' }, at: 5 };
  it('审计事件：合法与非法', () => {
    expect(AuditEventSchema.safeParse(ev).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...ev, eventType: '' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...ev, extra: 1 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...ev, seq: 0 }).success).toBe(false);
  });
});
