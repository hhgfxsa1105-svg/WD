import { describe, expect, it } from 'vitest';
import { describeAiConfig, loadAiConfig } from '../src/modules/ai/config.js';

const full = { AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://relay.example.com/v1', AI_API_KEY: 'sk-secret-key-123456', AI_MODEL: 'some-model' };

describe('loadAiConfig', () => {
  it('默认值：关闭 AI，并给出原因；各项上限使用约定默认值', () => {
    const c = loadAiConfig({});
    expect(c).toMatchObject({ provider: 'none', maxOutputTokens: 1000, dailyCallLimit: 200, maxRetries: 2, timeoutMs: 20_000, jsonMode: 'auto', maxInputChars: 6000 });
    expect(c.reason).toContain('未配置');
  });

  it('openai-compatible：三项齐全才启用', () => {
    const c = loadAiConfig(full);
    expect(c).toMatchObject({ provider: 'openai-compatible', reason: null, model: 'some-model', baseUrl: 'https://relay.example.com/v1' });
  });

  it.each([
    ['缺密钥', { ...full, AI_API_KEY: '' }, 'AI_API_KEY'],
    ['缺地址', { ...full, AI_BASE_URL: '' }, 'AI_BASE_URL'],
    ['缺模型', { ...full, AI_MODEL: '' }, 'AI_MODEL'],
  ])('%s：关闭并指明缺哪项', (_n, env, missing) => {
    const c = loadAiConfig(env);
    expect(c.provider).toBe('none');
    expect(c.reason).toContain(missing);
  });

  it('同时缺多项时全部列出', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'openai-compatible' }).reason).toContain('AI_BASE_URL、AI_API_KEY、AI_MODEL');
  });

  it.each([
    ['不是 URL', 'not a url'],
    ['非 http(s) 协议', 'ftp://example.com/v1'],
    ['file 协议', 'file:///etc/passwd'],
    ['javascript 协议', 'javascript:alert(1)'],
  ])('地址无效被拒绝：%s', (_n, url) => {
    const c = loadAiConfig({ ...full, AI_BASE_URL: url });
    expect(c.provider).toBe('none');
  });

  it('允许本机或内网的 http 中转站', () => {
    expect(loadAiConfig({ ...full, AI_BASE_URL: 'http://127.0.0.1:3001/v1' }).provider).toBe('openai-compatible');
    expect(loadAiConfig({ ...full, AI_BASE_URL: 'http://192.168.1.10:8080/v1' }).provider).toBe('openai-compatible');
  });

  it('mock 无需密钥；别名与大小写', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'mock' })).toMatchObject({ provider: 'mock', reason: null, model: 'keyword-mock' });
    expect(loadAiConfig({ AI_PROVIDER: ' MOCK ', AI_MODEL: 'm1' }).model).toBe('m1');
    expect(loadAiConfig({ ...full, AI_PROVIDER: 'OpenAI' }).provider).toBe('openai-compatible');
    expect(loadAiConfig({ AI_PROVIDER: 'none' }).provider).toBe('none');
  });

  it('不支持的供应商：关闭并提示可选项', () => {
    const c = loadAiConfig({ AI_PROVIDER: 'skynet' });
    expect(c.provider).toBe('none');
    expect(c.reason).toContain('openai-compatible');
  });

  it('数值项：合法值生效；越界或非数字时关闭而不是抛异常', () => {
    expect(loadAiConfig({ ...full, AI_DAILY_CALL_LIMIT: '50', AI_MAX_OUTPUT_TOKENS: '300', AI_MAX_RETRIES: '0' })).toMatchObject({ dailyCallLimit: 50, maxOutputTokens: 300, maxRetries: 0 });
    for (const bad of [{ AI_MAX_OUTPUT_TOKENS: '99999999' }, { AI_DAILY_CALL_LIMIT: 'abc' }, { AI_TIMEOUT_MS: '5' }, { AI_JSON_MODE: 'maybe' }, { AI_MAX_RETRIES: '-1' }]) {
      const c = loadAiConfig({ ...full, ...bad });
      expect(c.provider, JSON.stringify(bad)).toBe('none');
      expect(c.reason).toContain('不合法');
    }
  });

  it('每日上限可设为 0（等于禁止调用）', () => {
    expect(loadAiConfig({ ...full, AI_DAILY_CALL_LIMIT: '0' }).dailyCallLimit).toBe(0);
  });

  it('摘要不含密钥与地址', () => {
    const text = describeAiConfig(loadAiConfig(full));
    expect(text).toContain('some-model');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('relay.example.com');
    expect(describeAiConfig(loadAiConfig({}))).toContain('未启用');
  });
});
