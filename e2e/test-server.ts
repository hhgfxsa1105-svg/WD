/**
 * 端到端测试专用服务入口：与生产相同的应用与 SQLite 存档，
 * 额外提供可控的时钟、随机源与状态注入接口（仅本文件注册，生产代码不含任何测试后门）。
 */
import { PlayerStateSchema } from '@jhz/contracts';
import { buildApp } from '../apps/server/src/app.js';
import { loadEnv } from '../apps/server/src/config/env.js';
import { openDatabase } from '../apps/server/src/db/connection.js';
import { runMigrations } from '../apps/server/src/db/migrate.js';
import { createSqliteGameStore } from '../apps/server/src/modules/store/sqlite.js';
import { loadAiConfig } from '../apps/server/src/modules/ai/config.js';
import { createAiGateway } from '../apps/server/src/modules/ai/gateway.js';
import { createKeywordMockProvider } from '../apps/server/src/modules/ai/mock.js';
import { AiError, type AiProvider } from '../apps/server/src/modules/ai/types.js';
import { tickWorld } from '../apps/server/src/modules/world-events/service.js';
import { WorldClock } from '../apps/server/src/shared/world-clock.js';

const env = loadEnv();
const database = openDatabase(env.DB_PATH);
runMigrations(database.db);
const store = createSqliteGameStore(database.db);

// 与生产相同的世界时钟；系统时间 = 真实时间 + 可控偏移（可为负，用来模拟系统时间被调早）
const control = { offsetMs: 0, rng: 0.5 };
const clock = new WorldClock(store.worldClock, { wall: () => Date.now() + control.offsetMs });
// 默认让离线判定不介入（阈值极大），专注测其他功能；E2E_REAL_OFFLINE=1 时使用真实默认离线策略
const offline = process.env.E2E_REAL_OFFLINE === '1' ? undefined : { thresholdMs: Number.MAX_SAFE_INTEGER };

// AI：可控的模拟供应商（解析用关键词规则；可让解析或叙事失败）；E2E_AI=off 时完全关闭
const NARRATE_TEXT = '山风掠过衣袖，你凝神静气，经脉中真气奔涌不息，一切都在无声中改变。';
const aiControl = { parse: 'ok' as 'ok' | 'fail', narrate: 'ok' as 'ok' | 'fail' };
const keyword = createKeywordMockProvider('e2e-mock');
const provider: AiProvider = {
  name: 'mock',
  model: 'e2e-mock',
  async complete(req) {
    const mode = req.purpose === 'narrate' ? aiControl.narrate : aiControl.parse;
    if (mode === 'fail') throw new AiError('SERVER_ERROR', 'e2e 注入的故障', 500);
    if (req.purpose === 'narrate') return { text: NARRATE_TEXT, model: 'e2e-mock', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 1, attempts: 1, finishReason: 'stop', jsonModeUsed: false };
    return keyword.complete(req);
  },
};
const aiOff = process.env.E2E_AI === 'off';
const aiConfig = aiOff ? loadAiConfig({}) : { ...loadAiConfig({ AI_PROVIDER: 'mock' }), dailyCallLimit: 100 };
const ai = createAiGateway({ config: aiConfig, provider: aiOff ? undefined : provider, log: store.aiLog, clock });
const app = await buildApp({ store, clock, rng: () => control.rng, offline, ai, narrate: { mode: 'important' }, clockBehindMs: () => clock.behindMs() });


app.post('/__test/advance', async (req) => {
  control.offsetMs += Number((req.body as { ms: number }).ms);
  return { offsetMs: control.offsetMs };
});
app.post('/__test/ai', async (req) => {
  const b = req.body as { parse?: 'ok' | 'fail'; narrate?: 'ok' | 'fail'; dailyLimit?: number };
  if (b.parse) aiControl.parse = b.parse;
  if (b.narrate) aiControl.narrate = b.narrate;
  if (typeof b.dailyLimit === 'number') aiConfig.dailyCallLimit = b.dailyLimit;
  return { ...aiControl, dailyLimit: aiConfig.dailyCallLimit };
});
app.post('/__test/rng', async (req) => {
  control.rng = Number((req.body as { value: number }).value);
  return { rng: control.rng };
});
app.post('/__test/player', async (req) => {
  const patch = req.body as Record<string, unknown>;
  const next = store.transact((tx) => tx.savePlayer(PlayerStateSchema.parse({ ...tx.player(), ...patch })));
  return { version: next.version };
});
app.post('/__test/game-clock', async (req) => {
  const { minutes } = req.body as { minutes: number };
  // 与真实流程一致：时间推进之后，到期的世界事件随即发生
  return { minutes: store.transact((tx) => { const m = tx.advanceGameClock(minutes); tickWorld(tx, { at: Date.now(), actionId: null }); return m; }) };
});
app.post('/__test/location', async (req) => {
  const { id, status, reason } = req.body as { id: string; status: 'open' | 'blocked'; reason?: string };
  store.transact((tx) => tx.setLocationStatus(id, status, reason ?? null));
  return { ok: true };
});
app.post('/__test/item', async (req) => {
  const { itemId, quantity } = req.body as { itemId: string; quantity: number };
  store.transact((tx) => tx.addItem(itemId, quantity));
  return { ok: true };
});

await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  clock.flush();
  await app.close();
  database.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
