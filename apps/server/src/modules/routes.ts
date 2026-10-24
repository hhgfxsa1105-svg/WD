import type { FastifyInstance } from 'fastify';
import {
  AiStatusResponseSchema,
  AuditActionResponseSchema,
  InventoryResponseSchema,
  NpcListResponseSchema,
  NpcMemoryListResponseSchema,
  RelationExplainResponseSchema,
  QuestListResponseSchema,
  LogResponseSchema,
  PlayerStateSchema,
  SubmitActionRequestSchema,
  WorldTimeResponseSchema,
} from '@jhz/contracts';
import { NPC_DEFS, isNpcId, locationName, selectMemories } from '@jhz/game-rules';
import { z } from 'zod';
import { AppError, parseWith } from '../shared/errors.js';
import type { ActionService } from './action/service.js';
import type { FreeActionService } from './action/free.js';
import type { CultivationService } from './cultivation/service.js';
import type { GameStore } from './store/types.js';
import type { Clock } from '../shared/runtime.js';
import type { AiGateway } from './ai/gateway.js';
import { explainRelation } from './npc/explain.js';
import { questViews } from './quest/service.js';
import type { Narrator } from './narrative/service.js';

interface Deps {
  store: GameStore;
  actions: ActionService;
  cultivation: CultivationService;
  clock: Clock;
  /** 系统时间落后于世界时间的时长（仅 WorldClock 提供），正常为 0 */
  clockBehindMs: () => number;
  ai: AiGateway;
  free: FreeActionService;
  narrator: Narrator;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function registerGameRoutes(app: FastifyInstance, { store, actions, cultivation, clock, clockBehindMs, ai, free, narrator }: Deps) {
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

  // NPC 列表：静态显示文字 + 当前状态 + 对玩家的态度
  app.get('/api/v1/world/npcs', async () =>
    NpcListResponseSchema.parse({
      npcs: store.read((tx) => {
        const rels = tx.relationships();
        return tx.npcs().flatMap((n) => {
          if (!isNpcId(n.id)) return [];
          const d = NPC_DEFS[n.id];
          const rel = rels.find((r) => r.npcId === n.id && r.targetType === 'player');
          return [{ id: n.id, name: d.name, role: d.role, intro: d.intro, location: { id: n.locationId, name: locationName(n.locationId) ?? n.locationId }, status: n.status, goals: n.goals, towardPlayer: { affinity: rel?.affinity ?? 0, trust: rel?.trust ?? 0, hostility: rel?.hostility ?? 0 } }];
        });
      }),
    }),
  );

  // 解释某个 NPC 对某对象（默认玩家）的关系数值来源：初始值 + 审计事件里的每次变化 = 当前值（只读）
  app.get<{ Params: { id: string } }>('/api/v1/world/npcs/:id/relation', async (req) => {
    const { target } = parseWith(z.object({ target: z.string().max(64).default('player') }).strict(), req.query);
    if (!isNpcId(req.params.id)) throw new AppError('NOT_FOUND', '没有这个人物');
    const t = target === 'player' ? { type: 'player' as const, id: 'player_1' } : isNpcId(target) && target !== req.params.id ? { type: 'npc' as const, id: target } : null;
    if (!t) throw new AppError('NOT_FOUND', '没有这个对象');
    return RelationExplainResponseSchema.parse(store.read((tx) => explainRelation(tx, req.params.id, t)));
  });

  // 某个 NPC 的记忆（只读）：按时间正序；`context=1` 时返回对话上下文用的精选（条数与字数受限）
  app.get<{ Params: { id: string } }>('/api/v1/world/npcs/:id/memories', async (req) => {
    const { context } = parseWith(z.object({ context: z.enum(['0', '1']).default('0') }).strict(), req.query);
    if (!isNpcId(req.params.id)) throw new AppError('NOT_FOUND', '没有这个人物');
    const all = store.read((tx) => tx.memories(req.params.id));
    return NpcMemoryListResponseSchema.parse({ npcId: req.params.id, memories: context === '1' ? selectMemories(all) : all });
  });

  // 任务列表（只读）：静态文字 + 当前状态；接取、领取、放弃走 POST /actions（kind: quest）
  app.get('/api/v1/quests', async () => QuestListResponseSchema.parse({ quests: store.read((tx) => questViews(tx)) }));

  app.get('/api/v1/player/state', async () => PlayerStateSchema.parse(store.read((tx) => tx.player())));
  app.get('/api/v1/player/inventory', async () => InventoryResponseSchema.parse({ items: store.read((tx) => tx.inventory()) }));

  app.post('/api/v1/actions', async (req) => {
    const body = parseWith(SubmitActionRequestSchema, req.body);
    if (body.kind === 'free') return free.submit(body);
    const { response, fresh } = actions.submitFresh(body);
    return fresh ? narrator.complete(response) : response; // 结算先提交；叙事失败不影响结果
  });
  // 重新生成叙事：只改文字，不改任何状态；已完成的行动直接返回，不调用 AI
  app.post<{ Params: { id: string } }>('/api/v1/actions/:id/narrate', async (req) => narrator.retry(req.params.id));
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
