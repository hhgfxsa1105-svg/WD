import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HealthResponse } from '@jhz/contracts';

const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: false });

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    name: '江湖志',
    version: '0.1.0',
  }));

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
  }

  return app;
}
