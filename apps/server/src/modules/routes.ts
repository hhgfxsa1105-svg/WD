import type { FastifyInstance } from 'fastify';
import { PlayerStateSchema, SubmitActionRequestSchema } from '@jhz/contracts';
import { parseWith } from '../shared/errors.js';
import type { ActionService } from './action/service.js';
import type { PlayerStore } from './player/store.js';

interface Deps {
  store: PlayerStore;
  actions: ActionService;
}

export function registerGameRoutes(app: FastifyInstance, { store, actions }: Deps) {
  app.get('/api/v1/player/state', async () => PlayerStateSchema.parse(store.get()));

  app.post('/api/v1/actions', async (req) => {
    const body = parseWith(SubmitActionRequestSchema, req.body);
    return actions.submit(body);
  });

  app.get<{ Params: { id: string } }>('/api/v1/actions/:id', async (req) => actions.get(req.params.id));
}
