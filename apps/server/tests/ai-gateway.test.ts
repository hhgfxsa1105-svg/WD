import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AiStatusResponseSchema, ErrorResponseSchema } from '@jhz/contracts';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { createAiGateway, localDay } from '../src/modules/ai/gateway.js';
import { loadAiConfig, type AiConfig } from '../src/modules/ai/config.js';
import { createGatewayFromConfig } from '../src/modules/ai/index.js';
import { createKeywordMockProvider, createMockProvider } from '../src/modules/ai/mock.js';
import { AiError, type AiRequest } from '../src/modules/ai/types.js';
import { createMemoryGameStore } from '../src/modules/store/memory.js';
import { createSqliteGameStore } from '../src/modules/store/sqlite.js';
import type { GameStore } from '../src/modules/store/types.js';

const KEY = 'sk-gateway-secret-xyz987654';
const T0 = new Date(2026, 9, 23, 10, 0, 0).getTime(); // 本地时间 2026-10-23 10:00
const DAY = 24 * 3600_000;
const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({
  ...loadAiConfig({ AI_PROVIDER: 'mock' }),
  apiKey: KEY,
  baseUrl: 'https://relay.example.com/v1',
  dailyCallLimit: 3,
  maxOutputTokens: 500,
  maxInputChars: 100,
  ...over,
});
const req = (content = '你好', over: Partial<AiRequest> = {}): AiRequest => ({ messages: [{ role: 'user', content }], purpose: 'parse', ...over });

function setup(opts: { config?: Partial<AiConfig>; store?: GameStore; steps?: Parameters<typeof createMockProvider>[0] } = {}) {
  const store = opts.store ?? createMemoryGameStore();
  const time = { t: T0 };
  const mock = createMockProvider({ fallback: '{"ok":true}', ...opts.steps });
  const gw = createAiGateway({ config: cfg(opts.config), provider: mock, log: store.aiLog, clock: { now: () => time.t } });
  return { store, time, mock, gw };
}
const kind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as AiError).kind;
  }
  return 'OK';
};

describe('网关：启用状态', () => {
  it('未启用：DISABLED，不产生任何记录', async () => {
    const store = createMemoryGameStore();
    const gw = createAiGateway({ config: loadAiConfig({}), log: store.aiLog, clock: { now: () => T0 } });
    expect(gw.enabled).toBe(false);
    expect(await kind(gw.complete(req()))).toBe('DISABLED');
    expect(store.aiLog.usedOn(localDay(T0))).toBe(0);
    expect(gw.status()).toMatchObject({ enabled: false, provider: 'none', model: null, usedToday: 0 });
    expect(gw.status().reason).toContain('未配置');
  });

  it('配置不完整时关闭，原因写明缺什么', async () => {
    const store = createMemoryGameStore();
    const gw = createGatewayFromConfig(loadAiConfig({ AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://a.com/v1' }), store.aiLog, { now: () => T0 });
    expect(gw.enabled).toBe(false);
    expect(gw.status().reason).toContain('AI_API_KEY');
    expect(await kind(gw.complete(req()))).toBe('DISABLED');
  });

  it('mock 配置可直接使用（无需密钥）', async () => {
    const store = createMemoryGameStore();
    const gw = createGatewayFromConfig(loadAiConfig({ AI_PROVIDER: 'mock' }), store.aiLog, { now: () => T0 });
    expect(gw.enabled).toBe(true);
    const r = await gw.complete(req('我想休息'));
    expect(JSON.parse(r.text).action_type).toBe('rest');
  });
});

describe('网关：每日额度', () => {
  it('达到上限后拒绝，且不再调用供应商', async () => {
    const { gw, mock } = setup();
    for (let i = 0; i < 3; i++) await gw.complete(req());
    expect(await kind(gw.complete(req()))).toBe('BUDGET_EXCEEDED');
    expect(mock.calls).toHaveLength(3);
    expect(gw.status()).toMatchObject({ dailyLimit: 3, usedToday: 3, remaining: 0 });
  });

  it('失败的调用同样计入额度（真实请求已发出，可能已计费）', async () => {
    const { gw } = setup({ steps: { steps: [new AiError('SERVER_ERROR', 'x'), new AiError('TIMEOUT', 'x'), new AiError('REFUSED', 'x')] } });
    for (let i = 0; i < 3; i++) await gw.complete(req()).catch(() => undefined);
    expect(gw.status().usedToday).toBe(3);
    expect(await kind(gw.complete(req()))).toBe('BUDGET_EXCEEDED');
  });

  it('输入过大被拒绝：根本不发出，也不占用额度', async () => {
    const { gw, mock } = setup();
    expect(await kind(gw.complete(req('x'.repeat(101))))).toBe('INPUT_TOO_LARGE');
    expect(mock.calls).toHaveLength(0);
    expect(gw.status().usedToday).toBe(0);
  });

  it('输入上限按所有消息的总字符数计算', async () => {
    const { gw } = setup();
    const msgs = Array.from({ length: 6 }, () => ({ role: 'user' as const, content: 'y'.repeat(20) }));
    expect(await kind(gw.complete({ messages: msgs, purpose: 'parse' }))).toBe('INPUT_TOO_LARGE');
  });

  it('次日重新计数（按本地日期）', async () => {
    const { gw, time } = setup();
    for (let i = 0; i < 3; i++) await gw.complete(req());
    expect(await kind(gw.complete(req()))).toBe('BUDGET_EXCEEDED');
    time.t += DAY;
    expect(await kind(gw.complete(req()))).toBe('OK');
    expect(gw.status().usedToday).toBe(1);
  });

  it('上限为 0：任何调用都被拒绝', async () => {
    const { gw, mock } = setup({ config: { dailyCallLimit: 0 } });
    expect(await kind(gw.complete(req()))).toBe('BUDGET_EXCEEDED');
    expect(mock.calls).toHaveLength(0);
  });

  it('并发调用不会超出上限：10 个并发、上限 3 → 恰好 3 个发出', async () => {
    const { gw, mock } = setup({ steps: { fallback: { delayMs: 20, then: '{"ok":true}' } } });
    const results = await Promise.all(Array.from({ length: 10 }, () => kind(gw.complete(req()))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(3);
    expect(results.filter((r) => r === 'BUDGET_EXCEEDED')).toHaveLength(7);
    expect(mock.calls).toHaveLength(3);
  });
});

describe('网关：输出上限与记录', () => {
  it('maxTokens 不会超过配置：超大值被压低，未指定时使用上限', async () => {
    const { gw, mock } = setup();
    await gw.complete(req('a', { maxTokens: 99999 }));
    await gw.complete(req('b'));
    await gw.complete(req('c', { maxTokens: 50 }));
    expect(mock.calls.map((c) => c.maxTokens)).toEqual([500, 500, 50]);
  });

  it('成功记录：模型、用量、耗时、次数、长度', async () => {
    const { gw, store } = setup({ steps: { steps: [{ text: '{"ok":1}', usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 } }] } });
    const r = await gw.complete(req('abc'), { actionId: null });
    const rec = store.aiLog.recent(1)[0]!;
    expect(rec).toMatchObject({ id: r.callId, status: 'ok', errorKind: null, purpose: 'parse', provider: 'mock', model: 'mock-model', day: localDay(T0), promptTokens: 12, completionTokens: 34, totalTokens: 46, requestChars: 3, responseChars: 8, attempts: 1 });
  });

  it('失败记录：错误类别', async () => {
    const { gw, store } = setup({ steps: { steps: [new AiError('RATE_LIMITED', 'x')] } });
    await gw.complete(req()).catch(() => undefined);
    expect(store.aiLog.recent(1)[0]).toMatchObject({ status: 'error', errorKind: 'RATE_LIMITED' });
  });

  it('不存提示词与回复全文', async () => {
    const secretPrompt = '这是玩家的私密输入ABC123';
    const { gw, store } = setup({ steps: { steps: ['模型回复的内容XYZ789'] } });
    await gw.complete(req(secretPrompt));
    const dump = JSON.stringify(store.aiLog.recent(10));
    expect(dump).not.toContain('ABC123');
    expect(dump).not.toContain('XYZ789');
  });

  it('供应商抛出未预期的异常：被包装为 AiError 并脱敏', async () => {
    const { gw } = setup({ steps: { steps: [() => { throw new Error(`boom ${KEY}`); }] } });
    const e = await gw.complete(req()).catch((x) => x as AiError);
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).message).not.toContain(KEY);
  });

  it('状态接口数据不含密钥与地址', () => {
    const { gw } = setup();
    const dump = JSON.stringify(gw.status());
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain('relay.example.com');
  });
});

describe('持久化：额度与记录跨重启', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jhz-ai-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const open = (file: string) => {
    const d = openDatabase(file);
    runMigrations(d.db);
    return { d, store: createSqliteGameStore(d.db) };
  };

  it('重启后当日已用次数不清零（不能靠重启绕过上限）', async () => {
    const file = join(dir, 'a.sqlite');
    const a = open(file);
    const g1 = setup({ store: a.store });
    for (let i = 0; i < 3; i++) await g1.gw.complete(req());
    a.d.close();

    const b = open(file);
    const g2 = setup({ store: b.store });
    expect(g2.gw.status().usedToday).toBe(3);
    expect(await kind(g2.gw.complete(req()))).toBe('BUDGET_EXCEEDED');
    b.d.close();
  });

  it('未结束的调用（预占后崩溃）按保守口径计入', () => {
    const { d, store } = open(join(dir, 'b.sqlite'));
    store.aiLog.reserve({ actionId: null, purpose: 'parse', provider: 'mock', model: 'm', day: localDay(T0), requestChars: 5, at: T0 });
    expect(store.aiLog.usedOn(localDay(T0))).toBe(1);
    expect(store.aiLog.recent(1)[0]!.status).toBe('pending');
    d.close();
  });

  it('表里没有任何存放提示词或回复正文的列', () => {
    const { d } = open(join(dir, 'c.sqlite'));
    const cols = (d.sqlite.prepare("select name from pragma_table_info('ai_call_logs')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toEqual(expect.arrayContaining(['prompt', 'response', 'content', 'text', 'messages']));
    expect(cols).toEqual(expect.arrayContaining(['request_chars', 'response_chars', 'total_tokens', 'day']));
    d.close();
  });
});

describe('接口 GET /ai/status', () => {
  it('默认关闭，返回原因；格式符合契约', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/status' });
    const s = AiStatusResponseSchema.parse(res.json());
    expect(s).toMatchObject({ enabled: false, provider: 'none', dailyLimit: 200, usedToday: 0, remaining: 200, maxOutputTokens: 1000 });
  });

  it('启用后返回模型、额度；响应里没有密钥或地址', async () => {
    const store = createMemoryGameStore();
    const config = loadAiConfig({ AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://relay.example.com/v1', AI_API_KEY: KEY, AI_MODEL: 'my-model', AI_DAILY_CALL_LIMIT: '5' });
    const ai = createAiGateway({ config, provider: createMockProvider({ model: 'my-model', fallback: '{}' }), log: store.aiLog, clock: { now: () => T0 } });
    await ai.complete(req());
    const app = await buildApp({ store, ai });
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/status' });
    const s = AiStatusResponseSchema.parse(res.json());
    expect(s).toMatchObject({ enabled: true, model: 'my-model', usedToday: 1, remaining: 4, dailyLimit: 5 });
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain('relay.example.com');
    expect(ErrorResponseSchema.safeParse(res.json()).success).toBe(false);
  });
});

describe('模拟供应商', () => {
  it('脚本按顺序消费，用完走 fallback；调用被记录', async () => {
    const m = createMockProvider({ steps: ['一', '二'], fallback: '尾' });
    const texts = [];
    for (let i = 0; i < 4; i++) texts.push((await m.complete(req(`q${i}`))).text);
    expect(texts).toEqual(['一', '二', '尾', '尾']);
    expect(m.calls.map((c) => c.messages[0]!.content)).toEqual(['q0', 'q1', 'q2', 'q3']);
  });

  it('没有脚本且没有 fallback：给出明确错误', async () => {
    expect(await kind(createMockProvider().complete(req()))).toBe('BAD_RESPONSE');
  });

  it('可注入错误、慢响应、按请求动态决定', async () => {
    const slept: number[] = [];
    const m = createMockProvider({
      sleep: async (ms) => void slept.push(ms),
      steps: [new AiError('TIMEOUT', 't'), { delayMs: 500, then: 'slow' }, (r) => `echo:${r.messages[0]!.content}`, { text: 'cut', finishReason: 'length' }],
    });
    expect(await kind(m.complete(req()))).toBe('TIMEOUT');
    expect((await m.complete(req())).text).toBe('slow');
    expect(slept).toEqual([500]);
    expect((await m.complete(req('hi'))).text).toBe('echo:hi');
    expect((await m.complete(req())).finishReason).toBe('length');
  });
});

describe('关键词模拟（本地无密钥体验）', () => {
  const p = createKeywordMockProvider();
  const plan = async (text: string, purpose: 'parse' | 'narrate' = 'parse') => JSON.parse((await p.complete({ messages: [{ role: 'user', content: text }], purpose, json: true })).text);

  it.each([
    ['我想修炼一会儿', 'cultivate'],
    ['打坐', 'cultivate'],
    ['休息一下', 'rest'],
    ['去睡觉', 'rest'],
    ['尝试突破', 'breakthrough'],
    ['开始挂机', 'start_idle'],
    ['放置修炼', 'start_idle'],
    ['停止修炼', 'stop_idle'],
    ['查看状态', 'check_status'],
    ['找人聊聊', 'talk'],
    ['今天天气不错', 'other'],
  ])('「%s」→ %s', async (text, action) => {
    expect((await plan(text)).action_type).toBe(action);
  });

  it('突破提到丹药则带丹药目标，明确说不用则不带', async () => {
    expect((await plan('吃颗丹药去突破')).target).toEqual({ type: 'item', id: 'pill_breakthrough_fan' });
    expect((await plan('不用丹药突破')).target).toBeNull();
  });

  it('只看玩家原话：system 消息里的关键词不会干扰', async () => {
    const r = await p.complete({ messages: [{ role: 'system', content: '可选动作：突破、修炼、休息' }, { role: 'user', content: '随便看看风景' }], purpose: 'parse' });
    expect(JSON.parse(r.text).action_type).toBe('other');
  });

  it('叙事用途返回一句话文本', async () => {
    const r = await p.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'narrate' });
    expect(r.text.length).toBeGreaterThan(5);
    expect(() => JSON.parse(r.text)).toThrow();
  });
});
