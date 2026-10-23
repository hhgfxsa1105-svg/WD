import { z } from 'zod';

export const REALMS = ['mortal', 'initiate', 'adept', 'master', 'grandmaster'] as const;
export const RealmSchema = z.enum(REALMS);
export type Realm = z.infer<typeof RealmSchema>;

export const ATTRIBUTE_KEYS = ['strength', 'agility', 'constitution', 'comprehension'] as const;
export const AttributeKeySchema = z.enum(ATTRIBUTE_KEYS);
export type AttributeKey = z.infer<typeof AttributeKeySchema>;

export const FIXED_ACTION_IDS = ['cultivate', 'rest'] as const;
export const FixedActionIdSchema = z.enum(FIXED_ACTION_IDS);
export type FixedActionId = z.infer<typeof FixedActionIdSchema>;

/** 行动状态机（技术说明书 5.1）：RECEIVED → … → COMPLETED，可失败转入 FAILED */
export const ACTION_STATUSES = [
  'RECEIVED',
  'PARSING',
  'VALIDATING',
  'RESOLVING',
  'COMMITTED',
  'NARRATED',
  'COMPLETED',
  'FAILED',
] as const;
export const ActionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'INTERNAL_ERROR',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
