import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@jhz/contracts';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('health', () => {
  it('返回合法的健康检查响应', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(res.json()).status).toBe('ok');
  });
});

describe('env', () => {
  it('默认仅监听本机', () => {
    expect(loadEnv({}).HOST).toBe('127.0.0.1');
  });
  it('拒绝非法端口', () => {
    expect(() => loadEnv({ PORT: '99999' })).toThrow();
  });
});
