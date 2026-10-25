import { z } from 'zod';
import { ErrorCodeSchema } from './enums.js';
import { LIMITS } from './limits.js';

/** 统一错误响应：不含堆栈、密钥或内部提示词 */
export const ErrorResponseSchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string().max(LIMITS.message.max),
    request_id: z.string().min(1),
  })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
