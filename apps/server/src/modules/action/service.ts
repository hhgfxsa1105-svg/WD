import { randomUUID } from 'node:crypto';
import {
  ActionResponseSchema,
  type ActionResponse,
  type ActionStatus,
  type SubmitActionRequest,
} from '@jhz/contracts';
import { resolveFixedAction } from '@jhz/game-rules';
import { AppError } from '../../shared/errors.js';
import type { PlayerStore } from '../player/store.js';

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

export function createActionService(store: PlayerStore) {
  const actions = new Map<string, ActionResponse>();
  const byKey = new Map<string, IdempotencyEntry>();

  function submit(req: SubmitActionRequest): ActionResponse {
    if (req.kind === 'free') {
      throw new AppError('PRECONDITION_FAILED', '自由行动尚未开放，请使用固定行动');
    }

    const fingerprint = `${req.kind}:${req.actionId}`;
    const seen = byKey.get(req.idempotencyKey);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
      }
      // 重试：返回首次结果，不重复结算
      return structuredClone(actions.get(seen.actionId)!);
    }

    let status: ActionStatus = 'RECEIVED';
    status = advance(status, 'VALIDATING');
    const current = store.get();
    status = advance(status, 'RESOLVING');
    const result = resolveFixedAction(current, req.actionId);
    if (!result.ok) {
      advance(status, 'FAILED'); // 失败不产生副作用，也不占用幂等键
      throw new AppError('PRECONDITION_FAILED', result.message);
    }
    const committed = store.commit(result.player, current.version);
    status = advance(status, 'COMMITTED');
    status = advance(status, 'COMPLETED'); // 固定行动叙事为模板，随结算一并完成

    const response = ActionResponseSchema.parse({
      actionId: randomUUID(),
      status,
      narrative: result.narrative,
      changes: result.changes,
      player: committed,
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
