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
import type { GameStore, GameTx } from '../store/types.js';

interface IdempotencyEntry {
  fingerprint: string;
  actionId: string;
}

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
}

export interface ActionDeps {
  store: GameStore;
  clock: Clock;
  rng: Rng;
}

export function createActionService({ store, clock, rng }: ActionDeps) {
  const actions = new Map<string, ActionResponse>();
  const byKey = new Map<string, IdempotencyEntry>();

  /** 事务内结算：任何失败都会抛出，使丹药扣除与状态变更一并回滚 */
  function resolveInTx(tx: GameTx, req: Exclude<SubmitActionRequest, { kind: 'free' }>): Resolved {
    const player = tx.player();

    if (req.kind === 'fixed') {
      const r = resolveFixedAction(player, req.actionId);
      if (!r.ok) throw new AppError('PRECONDITION_FAILED', r.message);
      tx.savePlayer(r.player);
      return { changes: r.changes, narrative: r.narrative, breakthrough: null };
    }

    // 突破：先校验丹药，再结算；丹药在尝试时消耗，不论成败
    let pillGrade = null;
    if (req.pillItemId) {
      pillGrade = pillGradeOf(req.pillItemId);
      if (!pillGrade) throw new AppError('PRECONDITION_FAILED', '该物品不能用于突破');
    }
    const r = resolveBreakthrough(player, { now: clock.now(), rng, pillGrade });
    if (!r.ok) throw new AppError('PRECONDITION_FAILED', r.message);
    if (req.pillItemId) tx.takeItem(req.pillItemId, 1);
    tx.savePlayer(r.player);
    return {
      changes: r.changes,
      narrative: r.narrative,
      breakthrough: { outcome: r.outcome, chancePercent: r.chancePercent, roll: r.roll },
    };
  }

  function submit(req: SubmitActionRequest): ActionResponse {
    if (req.kind === 'free') {
      throw new AppError('PRECONDITION_FAILED', '自由行动尚未开放，请使用固定行动');
    }

    const fingerprint = req.kind === 'fixed' ? `fixed:${req.actionId}` : `breakthrough:${req.pillItemId ?? ''}`;
    const seen = byKey.get(req.idempotencyKey);
    if (seen) {
      if (seen.fingerprint !== fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
      // 重试：返回首次结果，不重复结算、不重复扣丹药
      return structuredClone(actions.get(seen.actionId)!);
    }

    let status: ActionStatus = 'RECEIVED';
    status = advance(status, 'VALIDATING');
    status = advance(status, 'RESOLVING');
    let resolved: Resolved;
    let player;
    try {
      ({ resolved, player } = store.transact((tx) => {
        const r = resolveInTx(tx, req);
        return { resolved: r, player: tx.player() };
      }));
    } catch (e) {
      advance(status, 'FAILED'); // 失败整体回滚，不产生副作用，也不占用幂等键
      throw e;
    }
    status = advance(status, 'COMMITTED');
    status = advance(status, 'COMPLETED'); // 固定行动与突破的叙事为模板，随结算一并完成

    const response = ActionResponseSchema.parse({
      actionId: randomUUID(),
      status,
      narrative: resolved.narrative,
      changes: resolved.changes,
      breakthrough: resolved.breakthrough,
      player,
    });
    actions.set(response.actionId, response);
    byKey.set(req.idempotencyKey, { fingerprint, actionId: response.actionId });
    return structuredClone(response);
  }

  function get(actionId: string): ActionResponse {
    const found = actions.get(actionId);
    if (!found) throw new AppError('NOT_FOUND', '行动不存在');
    return structuredClone(found);
  }

  return { submit, get };
}

export type ActionService = ReturnType<typeof createActionService>;
