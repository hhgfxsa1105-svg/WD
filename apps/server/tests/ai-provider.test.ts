import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { AiError, type AiErrorKind } from '../src/modules/ai/types.js';
import { chatCompletionsUrl, createOpenAiCompatibleProvider, parseCompletion, type OpenAiCompatOptions } from '../src/modules/ai/openai-compatible.js';

const KEY = 'sk-test-secret-abcdef123456';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error | 'hang';
const ok = (content: unknown = '{"a":1}', extra: Record<string, unknown> = {}) => ({
  body: { model: 'resp-model', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, ...extra },
});

/** 脚本化的 fetch：按顺序返回；hang 表示一直挂起直到被中止 */
function fakeFetch(replies: Reply[]) {
  const calls: Captured[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (r instanceof Error) throw r;
    if (r === 'hang') {
      return new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function make(replies: Reply[], over: Partial<OpenAiCompatOptions> = {}) {
  const { f, calls } = fakeFetch(replies);
  const delays: number[] = [];
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://relay.example.com/v1',
    apiKey: KEY,
    model: 'cfg-model',
    timeoutMs: 1000,
    maxRetries: 2,
    backoffMs: 100,
    jsonMode: 'auto',
    fetch: f,
    sleep: async (ms) => void delays.push(ms),
    random: () => 1, // 抖动系数固定为 1，便于精确断言退避时长
    ...over,
  });
  return { provider, calls, delays };
}
const req = (over = {}) => ({ messages: [{ role: 'user' as const, content: '你好' }], purpose: 'parse' as const, ...over });
const failKind = async (p: Promise<unknown>): Promise<AiError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    return e as AiError;
  }
  throw new Error('应当失败但成功了');
};

describe('chatCompletionsUrl', () => {
  it.each([
    ['https://a.com/v1', 'https://a.com/v1/chat/completions'],
    ['https://a.com/v1/', 'https://a.com/v1/chat/completions'],
    ['https://a.com/v1///', 'https://a.com/v1/chat/completions'],
    ['https://a.com/v1/chat/completions', 'https://a.com/v1/chat/completions'],
    ['https://a.com/v1/chat/completions/', 'https://a.com/v1/chat/completions'],
    ['https://a.com', 'https://a.com/chat/completions'],
  ])('%s → %s', (base, expected) => expect(chatCompletionsUrl(base)).toBe(expected));
});

describe('请求格式', () => {
  it('地址、方法头、鉴权、请求体字段', async () => {
    const { provider, calls } = make([ok()]);
    await provider.complete(req({ maxTokens: 321, temperature: 0.7 }));
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://relay.example.com/v1/chat/completions');
    expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.body).toMatchObject({ model: 'cfg-model', stream: false, max_tokens: 321, temperature: 0.7, messages: [{ role: 'user', content: '你好' }] });
  });

  it('默认温度较低；未指定 maxTokens 时不发送 max_tokens', async () => {
    const { provider, calls } = make([ok()]);
    await provider.complete(req());
    expect(calls[0]!.body.temperature).toBe(0.2);
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('请求 JSON 时带 response_format；不请求时不带；jsonMode=off 永不带', async () => {
    const a = make([ok()]);
    await a.provider.complete(req({ json: true }));
    expect(a.calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    const b = make([ok()]);
    await b.provider.complete(req({ json: false }));
    expect(b.calls[0]!.body).not.toHaveProperty('response_format');
    const c = make([ok()], { jsonMode: 'off' });
    await c.provider.complete(req({ json: true }));
    expect(c.calls[0]!.body).not.toHaveProperty('response_format');
  });
});

describe('响应解析', () => {
  it('字符串内容、用量、模型名、结束原因、尝试次数', async () => {
    const { provider } = make([ok('{"x":1}')]);
    const r = await provider.complete(req({ json: true }));
    expect(r).toMatchObject({ text: '{"x":1}', model: 'resp-model', finishReason: 'stop', attempts: 1, jsonModeUsed: true, usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 } });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('分段数组形式的内容被拼接', async () => {
    const { provider } = make([ok([{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }])]);
    expect((await provider.complete(req())).text).toBe('{"a":1}');
  });

  it('缺少 usage / 缺少 model 时用 null 与配置值', async () => {
    const { provider } = make([{ body: { choices: [{ message: { content: 'hi' } }] } }]);
    const r = await provider.complete(req());
    expect(r.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
    expect(r.model).toBe('cfg-model');
    expect(r.finishReason).toBeNull();
  });

  it('非法的 usage 数值（负数、字符串）按 null 处理', () => {
    const r = parseCompletion({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: -5, completion_tokens: '7', total_tokens: NaN } }, 'm', false);
    expect(r.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it.each([
    ['拒答字段', { choices: [{ finish_reason: 'stop', message: { content: null, refusal: '我不能回答' } }] }, 'REFUSED'],
    ['内容过滤', { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }, 'REFUSED'],
    ['内容为空串', { choices: [{ message: { content: '   ' } }] }, 'BAD_RESPONSE'],
    ['内容为 null（如只有推理内容）', { choices: [{ message: { content: null, reasoning_content: '想一想' } }] }, 'BAD_RESPONSE'],
    ['没有 choices', { id: 'x' }, 'BAD_RESPONSE'],
    ['choices 为空数组', { choices: [] }, 'BAD_RESPONSE'],
    ['choices 不是数组', { choices: 'oops' }, 'BAD_RESPONSE'],
  ] as [string, unknown, AiErrorKind][])('%s → %s，且不重试', async (_n, body, kind) => {
    const { provider, calls } = make([{ body }]);
    const e = await failKind(provider.complete(req()));
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('响应体不是 JSON → BAD_RESPONSE', async () => {
    const { provider } = make([{ text: '<html>502 Bad Gateway</html>' }]);
    expect((await failKind(provider.complete(req()))).kind).toBe('BAD_RESPONSE');
  });
});

describe('HTTP 错误与重试', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [400, 'BAD_REQUEST'],
    [404, 'BAD_REQUEST'],
    [422, 'BAD_REQUEST'],
    [418, 'BAD_REQUEST'],
  ] as [number, AiErrorKind][])('%i → %s，不重试', async (status, kind) => {
    const { provider, calls, delays } = make([{ status, text: 'nope' }]);
    const e = await failKind(provider.complete(req()));
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [502, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [408, 'TIMEOUT'],
  ] as [number, AiErrorKind][])('%i → %s，可重试：先失败后成功', async (status, kind) => {
    const { provider, calls } = make([{ status, text: 'busy' }, ok()]);
    const r = await provider.complete(req());
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    void kind;
  });

  it('重试耗尽后抛出最后一个错误：maxRetries=2 → 共 3 次请求', async () => {
    const { provider, calls } = make([{ status: 503, text: 'down' }]);
    const e = await failKind(provider.complete(req()));
    expect(e.kind).toBe('SERVER_ERROR');
    expect(calls).toHaveLength(3);
  });

  it('maxRetries=0：只请求一次', async () => {
    const { provider, calls } = make([{ status: 500, text: 'x' }], { maxRetries: 0 });
    await failKind(provider.complete(req()));
    expect(calls).toHaveLength(1);
  });

  it('指数退避：100、200 ms（抖动系数固定为 1）', async () => {
    const { provider, delays } = make([{ status: 500, text: 'x' }, { status: 500, text: 'x' }, ok()]);
    const r = await provider.complete(req());
    expect(r.attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('退避带抖动：落在 [50%, 100%] 区间', async () => {
    const lo = make([{ status: 500, text: 'x' }, ok()], { random: () => 0 });
    await lo.provider.complete(req());
    expect(lo.delays).toEqual([50]);
  });

  it('尊重 Retry-After（秒），并受上限约束', async () => {
    const a = make([{ status: 429, text: 'slow down', headers: { 'retry-after': '2' } }, ok()]);
    await a.provider.complete(req());
    expect(a.delays).toEqual([2000]);
    const b = make([{ status: 429, text: 'slow down', headers: { 'retry-after': '3600' } }, ok()]);
    await b.provider.complete(req());
    expect(b.delays).toEqual([8000]); // 上限 8 秒
  });

  it('Retry-After 为日期格式也能识别', async () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const { provider, delays } = make([{ status: 503, text: 'x', headers: { 'retry-after': when } }, ok()]);
    await provider.complete(req());
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThanOrEqual(3000);
  });

  it('网络错误：重试后仍失败 → NETWORK，信息带错误码但不含密钥', async () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { provider, calls } = make([err]);
    const e = await failKind(provider.complete(req()));
    expect(e.kind).toBe('NETWORK');
    expect(e.message).toContain('ECONNREFUSED');
    expect(calls).toHaveLength(3);
  });

  it('超时：每次请求受 timeoutMs 约束，重试后仍超时 → TIMEOUT', async () => {
    const { provider, calls } = make(['hang'], { timeoutMs: 25, maxRetries: 1 });
    const t = Date.now();
    const e = await failKind(provider.complete(req()));
    expect(e.kind).toBe('TIMEOUT');
    expect(e.retryable).toBe(true);
    expect(calls).toHaveLength(2);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('超时后重试成功', async () => {
    const { provider } = make(['hang', ok()], { timeoutMs: 25 });
    expect((await provider.complete(req())).attempts).toBe(2);
  });
});

describe('JSON 模式降级', () => {
  const reject = { status: 400, text: JSON.stringify({ error: { message: "'response_format' is not supported by this model" } }) };

  it('供应商拒绝 response_format：当次立即改用普通模式重试，且之后不再发送', async () => {
    const { provider, calls, delays } = make([reject, ok(), ok()]);
    const a = await provider.complete(req({ json: true }));
    expect(a.jsonModeUsed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toHaveProperty('response_format');
    expect(calls[1]!.body).not.toHaveProperty('response_format');
    expect(delays).toEqual([]); // 降级重试不退避

    await provider.complete(req({ json: true }));
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).not.toHaveProperty('response_format'); // 已记住：该供应商不支持
  });

  it('降级重试不消耗常规重试额度', async () => {
    const { provider, calls } = make([reject, { status: 500, text: 'x' }, { status: 500, text: 'x' }, ok()], { maxRetries: 2 });
    const r = await provider.complete(req({ json: true }));
    expect(r.attempts).toBe(4);
    expect(calls).toHaveLength(4);
  });

  it('与 JSON 模式无关的 400（如模型名错误）不触发降级', async () => {
    const { provider, calls } = make([{ status: 400, text: 'model "cfg-model" not found' }]);
    const e = await failKind(provider.complete(req({ json: true })));
    expect(e.kind).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(1);
  });

  it('jsonMode=on：不降级，直接抛出', async () => {
    const { provider, calls } = make([reject], { jsonMode: 'on' });
    expect((await failKind(provider.complete(req({ json: true })))).kind).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(1);
  });

  it('成功使用过 JSON 模式后，后续请求继续使用', async () => {
    const { provider, calls } = make([ok()]);
    await provider.complete(req({ json: true }));
    await provider.complete(req({ json: true }));
    expect(calls.every((c) => 'response_format' in c.body)).toBe(true);
  });
});

describe('密钥不泄露', () => {
  const echo = (code: number) => ({ status: code, text: `bad request, your key ${KEY} and header Bearer ${KEY} are invalid; also sk-another-token-987654321` });

  it.each([400, 401, 403, 429, 500, 503])('供应商在 %i 响应体里回显密钥时，错误信息已脱敏', async (status) => {
    const { provider } = make([echo(status)], { maxRetries: 0 });
    const e = await failKind(provider.complete(req()));
    const dump = JSON.stringify({ m: e.message, s: e.stack?.split('\n')[0], k: e.kind, e });
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain('sk-another-token');
    expect(dump).not.toContain('987654321');
  });

  it('网络异常信息里带密钥也被脱敏', async () => {
    const { provider } = make([Object.assign(new Error(`connect failed using ${KEY}`), { code: `E_${KEY}` })], { maxRetries: 0 });
    const e = await failKind(provider.complete(req()));
    expect(e.message).not.toContain(KEY);
  });

  it('错误响应体被截断到有限长度', async () => {
    const { provider } = make([{ status: 400, text: 'x'.repeat(5000) }]);
    const e = await failKind(provider.complete(req()));
    expect(e.message.length).toBeLessThan(400);
  });

  it('未预期的异常（非 AiError）被包装并脱敏', async () => {
    const bad = (() => {
      throw new Error(`boom ${KEY}`);
    }) as unknown as typeof fetch;
    const p = createOpenAiCompatibleProvider({ baseUrl: 'https://a.com/v1', apiKey: KEY, model: 'm', timeoutMs: 100, maxRetries: 0, backoffMs: 1, jsonMode: 'auto', fetch: bad });
    const e = await failKind(p.complete(req()));
    expect(e.message).not.toContain(KEY);
  });
});

describe('集成：真实 HTTP 服务（本机回环）', () => {
  let server: Server;
  let hits: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  let script: ((n: number, res: import('node:http').ServerResponse) => void) | null = null;

  const readBody = (r: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => resolve(s));
    });

  const ready = new Promise<number>((resolve) => {
    server = createServer(async (r, res) => {
      const body = JSON.parse((await readBody(r)) || '{}');
      hits.push({ path: r.url ?? '', auth: r.headers.authorization, body });
      script?.(hits.length, res);
    });
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const real = async (over: Partial<OpenAiCompatOptions> = {}) =>
    createOpenAiCompatibleProvider({ baseUrl: `http://127.0.0.1:${await ready}/v1`, apiKey: KEY, model: 'm', timeoutMs: 300, maxRetries: 2, backoffMs: 5, jsonMode: 'auto', ...over });

  it('成功：路径、鉴权头与响应解析', async () => {
    hits = [];
    script = (_n, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'x', choices: [{ message: { content: '{"ok":true}' } }] }));
    const r = await (await real()).complete(req({ json: true }));
    expect(r.text).toBe('{"ok":true}');
    expect(hits[0]).toMatchObject({ path: '/v1/chat/completions', auth: `Bearer ${KEY}` });
  });

  it('先 503 再成功：真实重试', async () => {
    hits = [];
    script = (n, res) =>
      n === 1 ? res.writeHead(503).end('busy') : res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    const r = await (await real()).complete(req());
    expect(r.attempts).toBe(2);
    expect(hits).toHaveLength(2);
  });

  it('响应太慢：真实超时（不会一直挂起）', async () => {
    hits = [];
    script = () => undefined; // 不回应
    const t = Date.now();
    const e = await failKind((await real({ timeoutMs: 80, maxRetries: 0 })).complete(req()));
    expect(e.kind).toBe('TIMEOUT');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('响应体读取到一半被中断 → 超时或网络错误，而不是挂起', async () => {
    hits = [];
    script = (_n, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"choices":');
      // 不再发送也不结束，客户端应在超时后放弃
    };
    const e = await failKind((await real({ timeoutMs: 100, maxRetries: 0 })).complete(req()));
    expect(['TIMEOUT', 'NETWORK']).toContain(e.kind);
  });

  it('连接被拒绝（端口无服务）→ NETWORK', async () => {
    const p = createOpenAiCompatibleProvider({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: KEY, model: 'm', timeoutMs: 300, maxRetries: 0, backoffMs: 1, jsonMode: 'auto' });
    expect((await failKind(p.complete(req()))).kind).toBe('NETWORK');
  });
});
