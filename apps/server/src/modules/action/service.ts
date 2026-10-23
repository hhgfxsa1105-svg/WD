import { randomUUID } from 'node:crypto';
import {
  ActionResponseSchema,
  type ActionResponse,
  type ActionStatus,
  type StateChange,
  type SubmitActionRequest,
} from '@jhz/contracts';
import { pillGradeOf, resolveBreakthrough, resolveFixedAction, type Rng } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../../shared/runtime.js';
import { snapshot, stateDiff } from '../audit/diff.js';
import type { GameStore, GameTx, LogPayload } from '../store/types.js';

/** 状态机允许的流转；已 COMMITTED 的行动不得再次结算 */
const NEXT: Record<ActionStatus, ActionStatus[]> = {
  RECEIVED: ['PARSING', 'VALIDATING', 'FAILED'],
  PARSING: ['VALIDATING', 'FAILED'],
  VALIDATING: ['RESOLVING', 'FAILED'],
  RESOLVING: ['COMMITTED', 'FAILED'],
  COMMITTED: ['NARRATED', 'COMPLETED'],
  NARRATED: ['COMPLETED'],
  COMPLETED: [],
  FAILED: [],
};

export function advance(from: ActionStatus, to: ActionStatus): ActionStatus {
  if (!NEXT[from].includes(to)) throw new Error(`非法行动状态流转：${from} → ${to}`);
  return to;
}

interface Resolved {
  changes: StateChange[];
  narrative: string;
  breakthrough: ActionResponse['breakthrough'];
  log: LogPayload;
}

export interface ActionDeps {
  store: GameStore;
  clock: Clock;
  rng: Rng;
  /** 该类事件是否交给 AI 叙事：是则结算后状态停在 COMMITTED（模板叙事），等待叙事完成 */
  narratable?: (type: LogPayload['type']) => boolean;
}

type Req = Exclude<SubmitActionRequest, { kind: 'free' }>;

/** 自由行动复用结算管线时的附加信息 */
export interface ExecuteExtra {
  /** 覆盖指纹（自由行动用「free:输入摘要」，使同键异输入返回 409） */
  fingerprint?: string;
  ai?: ActionResponse['ai'];
  /** 覆盖审计事件类型，如 action.free.cultivate */
  eventType?: string;
  /** 在事务内、结算之前执行的额外前置检查；失败请抛出 AppError */
  preCheck?: (tx: GameTx) => void;
}

export function createActionService({ store, clock, rng, narratable }: ActionDeps) {
  /** 事务内结算：任何失败都会抛出，使丹药扣除、状态变更、行动与审计记录一并回滚 */
  function resolveInTx(tx: GameTx, req: Req, now: number): Resolved {
    const player = tx.player();

    if (req.kind === 'fixed') {
      const r = resolveFixedAction(player, req.actionId);
      if (!r.ok) throw new AppError('PRECONDITION_FAILED', r.message);
      tx.savePlayer(r.player);
      return {
        changes: r.changes,
        narrative: r.narrative,
        breakthrough: null,
        log: { type: 'fixed', narrative: r.narrative, changes: r.changes, breakthrough: null, idle: null, note: null },
      };
    }

    // 突破：先校验丹药，再结算；丹药在尝试时消耗，不论成败
    let pillGrade = null;
    let pillName: string | null = null;
    if (req.pillItemId) {
      pillGrade = pillGradeOf(req.pillItemId);
      if (!pillGrade) throw new AppError('PRECONDITION_FAILED', '该物品不能用于突破');
      pillName = tx.inventory().find((i) => i.itemId === req.pillItemId)?.name ?? null;
    }
    const r = resolveBreakthrough(player, { now, rng, pillGrade });
    if (!r.ok) throw new AppError('PRECONDITION_FAILED', r.message);
    if (req.pillItemId) tx.takeItem(req.pillItemId, 1);
    tx.savePlayer(r.player);
    const breakthrough = { outcome: r.outcome, chancePercent: r.chancePercent, roll: r.roll };
    return {
      changes: r.changes,
      narrative: r.narrative,
      breakthrough,
      log: {
        type: 'breakthrough',
        narrative: r.narrative,
        changes: r.changes,
        breakthrough: { ...breakthrough, pillName, realmFrom: player.realm, realmTo: r.player.realm },
        idle: null,
        note: null,
      },
    };
  }

  const fingerprintOf = (req: Req) => (req.kind === 'fixed' ? `fixed:${req.actionId}` : `breakthrough:${req.pillItemId ?? ''}`);

  /** 只查重放：同一幂等键已有记录时返回首次结果（指纹不同则 409）；没有记录返回 null。自由行动用它在调用 AI 之前先拦截重复请求。 */
  function findReplay(idempotencyKey: string, fingerprint: string): ActionResponse | null {
    return store.read((tx) => {
      const seen = tx.findActionByKey(idempotencyKey);
      if (!seen) return null;
      if (seen.fingerprint !== fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
      return seen.response;
    });
  }

  /** 同 execute，并告知本次是否为新结算（false 表示幂等重放，调用方不应再触发叙事） */
  function executeFresh(req: Req, extra: ExecuteExtra = {}): { response: ActionResponse; fresh: boolean } {
    const fingerprint = extra.fingerprint ?? fingerprintOf(req);
    const now = clock.now();

    // 幂等检查、结算、行动记录、审计与日志都在同一个事务里：失败整体回滚，且不占用幂等键
    return store.transact((tx) => {
      const seen = tx.findActionByKey(req.idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
        return { response: seen.response, fresh: false }; // 重试：回放首次结果，不重复结算、不重复扣丹药
      }

      let status: ActionStatus = 'RECEIVED';
      status = advance(status, 'VALIDATING');
      status = advance(status, 'RESOLVING');
      const before = snapshot(tx);
      extra.preCheck?.(tx);
      const resolved = resolveInTx(tx, req, now);
      status = advance(status, 'COMMITTED');
      // 不交给 AI 叙事的事件，模板叙事随结算一并完成；交给 AI 的停在 COMMITTED，叙事成功后才 COMPLETED
      if (!narratable?.(resolved.log.type)) status = advance(status, 'COMPLETED');

      const actionId = randomUUID();
      const player = tx.player();
      const draft = ActionResponseSchema.parse({
        actionId,
        status,
        narrative: resolved.narrative,
        changes: resolved.changes,
        breakthrough: resolved.breakthrough,
        log: null,
        ai: extra.ai ?? null,
        player,
      });
      const base = { id: actionId, kind: req.kind, idempotencyKey: req.idempotencyKey, fingerprint, status, createdAt: now };
      tx.saveAction({ ...base, response: draft }); // 先落行动，审计事件才能引用它
      const diff = stateDiff(before, snapshot(tx));
      const log = tx.appendEvent({
        actionId,
        eventType: extra.eventType ?? (req.kind === 'fixed' ? `action.${req.actionId}` : 'action.breakthrough'),
        before: diff?.before ?? null,
        after: diff?.after ?? null,
        at: now,
        log: resolved.log,
      });
      const response = ActionResponseSchema.parse({ ...draft, log });
      tx.saveAction({ ...base, response });
      return { response, fresh: true };
    });
  }

  const execute = (req: Req, extra: ExecuteExtra = {}): ActionResponse => executeFresh(req, extra).response;

  function submitFresh(req: SubmitActionRequest): { response: ActionResponse; fresh: boolean } {
    if (req.kind === 'free') throw new AppError('PRECONDITION_FAILED', '自由行动请通过自由行动入口提交');
    return executeFresh(req);
  }

  const submit = (req: SubmitActionRequest): ActionResponse => submitFresh(req).response;

  function get(actionId: string): ActionResponse {
    const found = store.read((tx) => tx.getAction(actionId));
    if (!found) throw new AppError('NOT_FOUND', '行动不存在');
    return found.response;
  }

  return { submit, submitFresh, execute, executeFresh, findReplay, get };
}

export type ActionService = ReturnType<typeof createActionService>;
