import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatChanges } from '../src/changes';
import { ApiError, fetchPlayerState, newIdempotencyKey, submitFixedAction } from '../src/api/client';

describe('formatChanges', () => {
  it('格式化增减与单位，忽略 0', () => {
    expect(
      formatChanges([
        { stat: 'stamina', delta: -10 },
        { stat: 'realmProgress', delta: 11 },
        { stat: 'neili', delta: 6 },
        { stat: 'hp', delta: 0 },
      ]),
    ).toEqual([
      { text: '体力 −10', tone: 'down' },
      { text: '经验 +11%', tone: 'up' },
      { text: '内力 +6', tone: 'up' },
    ]);
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('服务端标准错误转为 ApiError，保留 code 与 request_id', async () => {
    stub(422, { code: 'PRECONDITION_FAILED', message: '体力不足', request_id: 'r-1' });
    await expect(submitFixedAction('cultivate')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: '体力不足',
      requestId: 'r-1',
    });
  });

  it('网络失败给出可读提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    await expect(fetchPlayerState()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('响应不符合契约时拒绝', async () => {
    stub(200, { hp: 'x' });
    await expect(fetchPlayerState()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchPlayerState()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('请求体包含幂等键与固定行动，且每次生成不同的键', async () => {
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'x', request_id: 'r' }), { status: 500 }),
    );
    vi.stubGlobal('fetch', fn);
    await submitFixedAction('rest', 'fixed-key-0001').catch(() => undefined);
    const body = JSON.parse(fn.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ kind: 'fixed', idempotencyKey: 'fixed-key-0001', actionId: 'rest' });
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
