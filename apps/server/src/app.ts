import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HealthResponse } from '@jhz/contracts';
import { createActionService } from './modules/action/service.js';
import { createGatewayFromConfig, loadAiConfig, type AiGateway } from './modules/ai/index.js';
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
  ai = createGatewayFromConfig(loadAiConfig({}), store.aiLog, clock),
  clockBehindMs = () => 0,
}: AppDeps = {}) {
  const app = Fastify({ logger: false, genReqId: newRequestId, bodyLimit: 16 * 1024 });

  registerErrorHandling(app);

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    name: '江湖志',
    version: '0.1.0',
  }));

  registerGameRoutes(app, {
    store,
    actions: createActionService({ store, clock, rng }),
    cultivation: createCultivationService({ store, clock, offline }),
    clock,
    clockBehindMs,
    ai,
  });

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  return app;
}
