import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema, SubmitActionRequestSchema } from '@jhz/contracts';
import { buildApp } from '../src/app.js';
import { AppError, parseWith } from '../src/shared/errors.js';

async function appWithRoutes() {
  const app = await buildApp();
  app.post('/t/echo', async (req) => parseWith(SubmitActionRequestSchema, req.body));
  app.get('/t/boom', async () => {
    throw new Error('db password=hunter2 at /srv/secret.ts:42');
  });
  app.get('/t/conflict', async () => {
    throw new AppError('CONFLICT', '状态已变化');
  });
  return app;
}

describe('统一错误响应', () => {
  it('合法请求通过校验', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      payload: { kind: 'fixed', idempotencyKey: 'abcdefgh-1', actionId: 'rest' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('非法请求返回 400 + 标准错误结构', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      payload: { kind: 'fixed', idempotencyKey: 'abcdefgh-1', actionId: 'rest', silver: 999999 },
    });
    expect(res.statusCode).toBe(400);
    const body = ErrorResponseSchema.parse(res.json());
    expect(body.code).toBe('VALIDATION_FAILED');
  });

  it('损坏的 JSON 返回 400 而非 500', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(res.json()).code).toBe('VALIDATION_FAILED');
  });

  it('超大请求体被拒绝', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      payload: { kind: 'free', idempotencyKey: 'abcdefgh-1', input: 'x'.repeat(20_000) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('未知错误返回 500，且不泄露堆栈或内部信息', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    const body = ErrorResponseSchema.parse(res.json());
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toMatch(/hunter2|secret\.ts|at /);
  });

  it('业务错误映射状态码，不存在的路径返回 404', async () => {
    const app = await appWithRoutes();
    expect((await app.inject({ method: 'GET', url: '/t/conflict' })).statusCode).toBe(409);
    const nf = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(nf.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(nf.json()).code).toBe('NOT_FOUND');
  });

  it('request_id 每次请求不同', async () => {
    const app = await appWithRoutes();
    const a = ErrorResponseSchema.parse((await app.inject({ method: 'GET', url: '/x' })).json());
    const b = ErrorResponseSchema.parse((await app.inject({ method: 'GET', url: '/x' })).json());
    expect(a.request_id).not.toBe(b.request_id);
  });
});
