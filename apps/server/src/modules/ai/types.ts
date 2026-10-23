export type AiPurpose = 'parse' | 'narrate';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  purpose: AiPurpose;
  /** 期望模型返回 JSON；供应商不支持时适配器会自动降级为普通模式 */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AiUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AiResponse {
  text: string;
  model: string;
  usage: AiUsage;
  latencyMs: number;
  /** 实际发起的 HTTP 请求次数（含重试） */
  attempts: number;
  finishReason: string | null;
  jsonModeUsed: boolean;
}

export type AiErrorKind =
  | 'DISABLED' // 未配置或已关闭
  | 'BUDGET_EXCEEDED' // 触达每日调用上限
  | 'INPUT_TOO_LARGE' // 请求内容超过上限，未发出
  | 'TIMEOUT'
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'AUTH' // 密钥无效或无权限
  | 'BAD_REQUEST' // 供应商认为请求不合法（含模型名错误）
  | 'REFUSED' // 模型拒答或被内容过滤
  | 'BAD_RESPONSE'; // 返回内容为空或结构不符合协议

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set(['TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'SERVER_ERROR']);

/** AI 调用错误；message 已脱敏，可安全写日志，但不应原样展示给玩家（玩家看到的是降级提示） */
export class AiError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
    /** 供应商建议的重试等待时间（毫秒，来自 Retry-After） */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiError';
    this.retryable = RETRYABLE.has(kind);
  }
}

/** 业务只依赖这个接口，不依赖任何具体供应商或 SDK */
export interface AiProvider {
  readonly name: 'mock' | 'openai-compatible';
  readonly model: string;
  complete(req: AiRequest): Promise<AiResponse>;
}
