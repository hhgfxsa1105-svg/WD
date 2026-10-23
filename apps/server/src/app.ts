import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HealthResponse } from '@jhz/contracts';
import { createFreeActionService } from './modules/action/free.js';
import { createActionService } from './modules/action/service.js';
import { createGatewayFromConfig, loadAiConfig, type AiGateway } from './modules/ai/index.js';
import { createNarrator } from './modules/narrative/service.js';
import { OFF_NARRATE, type NarrateConfig } from './modules/narrative/config.js';
import { createCultivationService, type OfflinePolicy } from './modules/cultivation/service.js';
import { createMemoryGameStore } from './modules/store/memory.js';
import type { GameStore } from './modules/store/types.js';
import { registerGameRoutes } from './modules/routes.js';
import type { Rng } from '@jhz/game-rules';
import { newRequestId, registerErrorHandling } from './shared/errors.js';
import { secureRng, systemClock, type Clock } from './shared/runtime.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface AppDeps {
  store?: GameStore;
  clock?: Clock;
  rng?: Rng;
  /** AI 网关；默认未启用 */
  ai?: AiGateway;
  /** AI 叙事配置；默认关闭（index.ts 从环境变量读取） */
  narrate?: Partial<NarrateConfig>;
  /** 覆盖默认离线策略（测试用） */
  offline?: Partial<OfflinePolicy>;
  /** 系统时间落后于世界时间的时长；仅 WorldClock 提供 */
  clockBehindMs?: () => number;
}

export async function buildApp({
  store = createMemoryGameStore(),
  clock = systemClock,
  rng = secureRng,
  offline,
  narrate,
  ai = createGatewayFromConfig(loadAiConfig({}), store.aiLog, clock),
  clockBehindMs = () => 0,
}: AppDeps = {}) {
  const app = Fastify({ logger: false, genReqId: newRequestId, bodyLimit: 16 * 1024, forceCloseConnections: true });

  registerErrorHandling(app);

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    name: '江湖志',
    version: '0.1.0',
  }));

  const narrator = createNarrator({ store, ai, clock, config: { ...OFF_NARRATE, ...narrate } });
  const actions = createActionService({ store, clock, rng, narratable: narrator.wants });
  const cultivation = createCultivationService({ store, clock, offline });
  registerGameRoutes(app, {
    store,
    actions,
    cultivation,
    clock,
    clockBehindMs,
    ai,
    narrator,
    free: createFreeActionService({ store, actions, cultivation, ai, narrator }),
  });


  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  return app;
}
