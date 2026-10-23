import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, ErrorResponseSchema, PlayerStateSchema } from '@jhz/contracts';
import { buildApp } from '../src/app.js';
import { advance } from '../src/modules/action/service.js';

const key = (n: number) => `test-key-${String(n).padStart(4, '0')}`;
const fixed = (id: 'cultivate' | 'rest', n: number) => ({ kind: 'fixed', idempotencyKey: key(n), actionId: id });

async function setup() {
  const app = await buildApp();
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/actions', payload: payload as object });
  const state = async () => PlayerStateSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/player/state' })).json());
  return { app, post, state };
}

describe('GET /player/state', () => {
  it('返回合法的初始角色', async () => {
    const { state } = await setup();
    const s = await state();
    expect(s.version).toBe(0);
    expect(s.stamina).toBe(50);
  });
});

describe('POST /actions 固定行动', () => {
  it('修炼：返回结果与最新状态，且与 GET 一致', async () => {
    const { post, state } = await setup();
    const res = await post(fixed('cultivate', 1));
    expect(res.statusCode).toBe(200);
    const body = ActionResponseSchema.parse(res.json());
    expect(body.status).toBe('COMPLETED');
    expect(body.player.stamina).toBe(40);
    expect(body.player.version).toBe(1);
    expect(body.changes).toContainEqual({ stat: 'stamina', delta: -10 });
    expect(await state()).toEqual(body.player);
  });

  it('休息：体力不超过上限', async () => {
    const { post } = await setup();
    await post(fixed('cultivate', 1));
    const body = ActionResponseSchema.parse((await post(fixed('rest', 2))).json());
    expect(body.player.stamina).toBe(50);
    expect(body.player.hp).toBe(100);
  });

  it('幂等：相同幂等键重试只结算一次，返回同一 actionId', async () => {
    const { post, state } = await setup();
    const a = ActionResponseSchema.parse((await post(fixed('cultivate', 7))).json());
    const b = ActionResponseSchema.parse((await post(fixed('cultivate', 7))).json());
    expect(b.actionId).toBe(a.actionId);
    expect(b.player).toEqual(a.player);
    const s = await state();
    expect(s.stamina).toBe(40);
    expect(s.version).toBe(1);
  });

  it('并发重复提交同一幂等键，只产生一次状态变更', async () => {
    const { post, state } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(fixed('cultivate', 9))));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(results.map((r) => ActionResponseSchema.parse(r.json()).actionId)).size).toBe(1);
    expect((await state()).stamina).toBe(40);
  });

  it('同一幂等键用于不同行动返回 409，且不改变状态', async () => {
    const { post, state } = await setup();
    await post(fixed('cultivate', 3));
    const res = await post(fixed('rest', 3));
    expect(res.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(res.json()).code).toBe('CONFLICT');
    expect((await state()).version).toBe(1);
  });

  it('体力不足返回 422，状态不变，且失败不占用幂等键', async () => {
    const { post, state } = await setup();
    for (let i = 0; i < 5; i++) expect((await post(fixed('cultivate', 100 + i))).statusCode).toBe(200);
    const before = await state();
    expect(before.stamina).toBe(0);
    const fail = await post(fixed('cultivate', 200));
    expect(fail.statusCode).toBe(422);
    expect(ErrorResponseSchema.parse(fail.json()).code).toBe('PRECONDITION_FAILED');
    expect(await state()).toEqual(before);
    // 休息后，同一个幂等键可以重新用于修炼
    await post(fixed('rest', 201));
    expect((await post(fixed('cultivate', 200))).statusCode).toBe(200);
  });

  it('自由行动：AI 未开启时返回 503 与友好提示，状态不变', async () => {
    const { post, state } = await setup();
    const res = await post({ kind: 'free', idempotencyKey: key(1), input: '拜访掌门' });
    expect(res.statusCode).toBe(503);
    const body = ErrorResponseSchema.parse(res.json());
    expect(body.code).toBe('AI_UNAVAILABLE');
    expect(body.message).toContain('固定选项');
    expect((await state()).version).toBe(0);
  });

  it.each([
    ['缺幂等键', { kind: 'fixed', actionId: 'rest' }],
    ['未知行动', { kind: 'fixed', idempotencyKey: key(1), actionId: 'steal' }],
    ['携带前端数值', { ...fixed('rest', 1), silver: 99999 }],
    ['非对象', 'rest'],
  ])('非法请求返回 400：%s', async (_n, payload) => {
    const { post, state } = await setup();
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(res.json()).code).toBe('VALIDATION_FAILED');
    expect((await state()).version).toBe(0);
  });
});

describe('GET /actions/:id', () => {
  it('可查询已完成行动；未知 ID 返回 404；查询不重复执行', async () => {
    const { app, post, state } = await setup();
    const a = ActionResponseSchema.parse((await post(fixed('cultivate', 1))).json());
    const got = await app.inject({ method: 'GET', url: `/api/v1/actions/${a.actionId}` });
    expect(ActionResponseSchema.parse(got.json())).toEqual(a);
    expect((await state()).version).toBe(1);
    const nf = await app.inject({ method: 'GET', url: '/api/v1/actions/nope' });
    expect(nf.statusCode).toBe(404);
  });
});

describe('行动状态机', () => {
  it('允许正常流转，禁止回退与已提交后的失败', () => {
    expect(advance('RECEIVED', 'VALIDATING')).toBe('VALIDATING');
    expect(advance('RESOLVING', 'COMMITTED')).toBe('COMMITTED');
    expect(() => advance('COMMITTED', 'FAILED')).toThrow();
    expect(() => advance('COMPLETED', 'RESOLVING')).toThrow();
    expect(() => advance('FAILED', 'COMMITTED')).toThrow();
  });
});
