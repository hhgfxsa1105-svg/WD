import {
  ActionResponseSchema,
  CultivationResponseSchema,
  ErrorResponseSchema,
  InventoryResponseSchema,
  LogResponseSchema,
  PlayerStateSchema,
  WorldTimeResponseSchema,
  type ActionResponse,
  type CultivationResponse,
  type FixedActionId,
  type InventoryItem,
  type LogRecord,
  type PlayerState,
  type SubmitActionRequest,
  type WorldTimeResponse,
} from '@jhz/contracts';

/** 接口错误：message 可直接展示给玩家 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, schema: { parse: (d: unknown) => T }, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('NETWORK', '无法连接本地服务，请确认游戏服务已启动');
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorResponseSchema.safeParse(data);
    if (err.success) throw new ApiError(err.data.code, err.data.message, err.data.request_id);
    throw new ApiError('UNKNOWN', `请求失败（${res.status}）`);
  }
  try {
    return schema.parse(data);
  } catch {
    throw new ApiError('BAD_RESPONSE', '服务返回的数据格式不正确');
  }
}

export const fetchPlayerState = (): Promise<PlayerState> => request('/api/v1/player/state', PlayerStateSchema);

export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const fetchInventory = async (): Promise<InventoryItem[]> =>
  (await request('/api/v1/player/inventory', InventoryResponseSchema)).items;

const postJson = <T>(path: string, schema: { parse: (d: unknown) => T }, body?: unknown) =>
  request(path, schema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const submit = (body: SubmitActionRequest): Promise<ActionResponse> => postJson('/api/v1/actions', ActionResponseSchema, body);

export const submitFixedAction = (actionId: FixedActionId, idempotencyKey = newIdempotencyKey()): Promise<ActionResponse> =>
  submit({ kind: 'fixed', idempotencyKey, actionId });

export const submitBreakthrough = (pillItemId: string | null, idempotencyKey = newIdempotencyKey()): Promise<ActionResponse> =>
  submit({ kind: 'breakthrough', idempotencyKey, pillItemId });

export const fetchCultivation = (): Promise<CultivationResponse> => request('/api/v1/cultivation', CultivationResponseSchema);
export const startCultivation = (): Promise<CultivationResponse> => postJson('/api/v1/cultivation/start', CultivationResponseSchema);
export const settleCultivation = (): Promise<CultivationResponse> => postJson('/api/v1/cultivation/settle', CultivationResponseSchema);
export const stopCultivation = (): Promise<CultivationResponse> => postJson('/api/v1/cultivation/stop', CultivationResponseSchema);

export const fetchWorldTime = (): Promise<WorldTimeResponse> => request('/api/v1/world/time', WorldTimeResponseSchema);

export const fetchLog = async (limit = 100): Promise<LogRecord[]> => (await request(`/api/v1/log?limit=${limit}`, LogResponseSchema)).entries;
