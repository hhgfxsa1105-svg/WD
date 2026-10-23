import type { FastifyInstance } from 'fastify';
import { InventoryResponseSchema, PlayerStateSchema, SubmitActionRequestSchema } from '@jhz/contracts';
import { parseWith } from '../shared/errors.js';
import type { ActionService } from './action/service.js';
import type { CultivationService } from './cultivation/service.js';
import type { GameStore } from './store/types.js';

interface Deps {
  store: GameStore;
  actions: ActionService;
  cultivation: CultivationService;
}

export function registerGameRoutes(app: FastifyInstance, { store, actions, cultivation }: Deps) {
  app.get('/api/v1/player/state', async () => PlayerStateSchema.parse(store.read((tx) => tx.player())));
  app.get('/api/v1/player/inventory', async () => InventoryResponseSchema.parse({ items: store.read((tx) => tx.inventory()) }));

  app.post('/api/v1/actions', async (req) => actions.submit(parseWith(SubmitActionRequestSchema, req.body)));
  app.get<{ Params: { id: string } }>('/api/v1/actions/:id', async (req) => actions.get(req.params.id));

  app.get('/api/v1/cultivation', async () => cultivation.get());
  app.post('/api/v1/cultivation/start', async () => cultivation.start());
  app.post('/api/v1/cultivation/settle', async () => cultivation.settle());
  app.post('/api/v1/cultivation/stop', async () => cultivation.stop());
}
