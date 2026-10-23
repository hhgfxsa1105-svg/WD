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
}

type Req = Exclude<SubmitActionRequest, { kind: 'free' }>;

export function createActionService({ store, clock, rng }: ActionDeps) {
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

  function submit(req: SubmitActionRequest): ActionResponse {
    if (req.kind === 'free') {
      throw new AppError('PRECONDITION_FAILED', '自由行动尚未开放，请使用固定行动');
    }
    const fingerprint = req.kind === 'fixed' ? `fixed:${req.actionId}` : `breakthrough:${req.pillItemId ?? ''}`;
    const now = clock.now();

    // 幂等检查、结算、行动记录、审计与日志都在同一个事务里：失败整体回滚，且不占用幂等键
    return store.transact((tx) => {
      const seen = tx.findActionByKey(req.idempotencyKey);
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new AppError('CONFLICT', '该幂等键已用于另一个行动');
        return seen.response; // 重试：回放首次结果，不重复结算、不重复扣丹药
      }

      let status: ActionStatus = 'RECEIVED';
      status = advance(status, 'VALIDATING');
      status = advance(status, 'RESOLVING');
      const before = snapshot(tx);
      const resolved = resolveInTx(tx, req, now);
      status = advance(status, 'COMMITTED');
      status = advance(status, 'COMPLETED'); // 固定行动与突破的叙事为模板，随结算一并完成

      const actionId = randomUUID();
      const player = tx.player();
      const draft = ActionResponseSchema.parse({
        actionId,
        status,
        narrative: resolved.narrative,
        changes: resolved.changes,
        breakthrough: resolved.breakthrough,
        log: null,
        player,
      });
      const base = { id: actionId, kind: req.kind, idempotencyKey: req.idempotencyKey, fingerprint, status, createdAt: now };
      tx.saveAction({ ...base, response: draft }); // 先落行动，审计事件才能引用它
      const diff = stateDiff(before, snapshot(tx));
      const log = tx.appendEvent({
        actionId,
        eventType: req.kind === 'fixed' ? `action.${req.actionId}` : 'action.breakthrough',
        before: diff?.before ?? null,
        after: diff?.after ?? null,
        at: now,
        log: resolved.log,
      });
      const response = ActionResponseSchema.parse({ ...draft, log });
      tx.saveAction({ ...base, response });
      return response;
    });
  }

  function get(actionId: string): ActionResponse {
    const found = store.read((tx) => tx.getAction(actionId));
    if (!found) throw new AppError('NOT_FOUND', '行动不存在');
    return found.response;
  }

  return { submit, get };
}

export type ActionService = ReturnType<typeof createActionService>;
