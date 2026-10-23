import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HealthResponse } from '@jhz/contracts';
import { createActionService } from './modules/action/service.js';
import { createMemoryPlayerStore, type PlayerStore } from './modules/player/store.js';
import { registerGameRoutes } from './modules/routes.js';
import { newRequestId, registerErrorHandling } from './shared/errors.js';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface AppDeps {
  store?: PlayerStore;
}

export async function buildApp({ store = createMemoryPlayerStore() }: AppDeps = {}) {
  const app = Fastify({ logger: false, genReqId: newRequestId, bodyLimit: 16 * 1024 });

  registerErrorHandling(app);

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    name: '江湖志',
    version: '0.1.0',
  }));

  registerGameRoutes(app, { store, actions: createActionService(store) });

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  return app;
}
