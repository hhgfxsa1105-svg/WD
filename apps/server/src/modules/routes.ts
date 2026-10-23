import type { FastifyInstance } from 'fastify';
import {
  AiStatusResponseSchema,
  AuditActionResponseSchema,
  InventoryResponseSchema,
  LogResponseSchema,
  PlayerStateSchema,
  SubmitActionRequestSchema,
  WorldTimeResponseSchema,
} from '@jhz/contracts';
import { z } from 'zod';
import { AppError, parseWith } from '../shared/errors.js';
import type { ActionService } from './action/service.js';
import type { CultivationService } from './cultivation/service.js';
import type { GameStore } from './store/types.js';
import type { Clock } from '../shared/runtime.js';
import type { AiGateway } from './ai/gateway.js';

interface Deps {
  store: GameStore;
  actions: ActionService;
  cultivation: CultivationService;
  clock: Clock;
  /** 系统时间落后于世界时间的时长（仅 WorldClock 提供），正常为 0 */
  clockBehindMs: () => number;
  ai: AiGateway;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function registerGameRoutes(app: FastifyInstance, { store, actions, cultivation, clock, clockBehindMs, ai }: Deps) {
  // AI 功能状态：不含任何密钥与地址
  app.get('/api/v1/ai/status', async () => AiStatusResponseSchema.parse(ai.status()));

  app.get('/api/v1/world/time', async () =>
    WorldTimeResponseSchema.parse({
      serverNow: clock.now(),
      offline: {
        thresholdMs: cultivation.policy.thresholdMs,
        capMs: cultivation.policy.capMs,
        efficiencyPercent: Math.round(cultivation.policy.efficiency * 100),
      },
      clockBehindMs: clockBehindMs(),
    }),
  );

  app.get('/api/v1/player/state', async () => PlayerStateSchema.parse(store.read((tx) => tx.player())));
  app.get('/api/v1/player/inventory', async () => InventoryResponseSchema.parse({ items: store.read((tx) => tx.inventory()) }));

  app.post('/api/v1/actions', async (req) => actions.submit(parseWith(SubmitActionRequestSchema, req.body)));
  app.get<{ Params: { id: string } }>('/api/v1/actions/:id', async (req) => actions.get(req.params.id));

  app.get('/api/v1/log', async (req) => {
    const { limit } = parseWith(z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict(), req.query);
    return LogResponseSchema.parse({ entries: store.read((tx) => tx.recentLog(limit)) });
  });

  // 内部审计查询：仅本机访问（服务本就只监听 127.0.0.1，这里再显式校验一次）
  app.get<{ Params: { id: string } }>('/api/v1/audit/actions/:id', async (req) => {
    if (!LOOPBACK.has(req.ip)) throw new AppError('FORBIDDEN', '仅允许本机访问');
    return store.read((tx) => {
      const action = tx.getAction(req.params.id);
      if (!action) throw new AppError('NOT_FOUND', '行动不存在');
      return AuditActionResponseSchema.parse({
        action: { id: action.id, kind: action.kind, status: action.status, idempotencyKey: action.idempotencyKey, createdAt: action.createdAt },
        events: tx.eventsForAction(action.id),
      });
    });
  });

  app.get('/api/v1/cultivation', async () => cultivation.get());
  app.post('/api/v1/cultivation/start', async () => cultivation.start());
  app.post('/api/v1/cultivation/settle', async () => cultivation.settle());
  app.post('/api/v1/cultivation/stop', async () => cultivation.stop());
}
