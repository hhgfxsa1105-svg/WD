import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodType, ZodTypeDef } from 'zod';
import type { ErrorCode, ErrorResponse } from '@jhz/contracts';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  AI_UNAVAILABLE: 503,
  CONFLICT: 409,
  PRECONDITION_FAILED: 422,
  INTERNAL_ERROR: 500,
};

/** 可安全返回给客户端的业务错误 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 服务端校验边界数据；失败只暴露字段路径与简要原因 */
export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  throw new AppError('VALIDATION_FAILED', `请求数据无效：${detail}`);
}

export const newRequestId = () => randomUUID();

export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    const body: ErrorResponse = { code: 'NOT_FOUND', message: '资源不存在', request_id: req.id };
    reply.status(404).send(body);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: ErrorResponse = { code: err.code, message: err.message, request_id: req.id };
      return reply.status(STATUS[err.code]).send(body);
    }
    // Fastify 自身的 4xx（如 JSON 解析失败、请求体过大）
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const body: ErrorResponse = { code: 'VALIDATION_FAILED', message: '请求格式无效', request_id: req.id };
      return reply.status(400).send(body);
    }
    // 未知错误：详情只写服务端日志，不返回客户端
    req.log.error({ err }, 'unhandled error');
    const body: ErrorResponse = { code: 'INTERNAL_ERROR', message: '服务器内部错误', request_id: req.id };
    return reply.status(500).send(body);
  });
}
