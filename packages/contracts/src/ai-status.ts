import { z } from 'zod';

/** AI 功能的运行状态；不含任何密钥或地址信息 */
export const AiStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['none', 'mock', 'openai-compatible']),
    model: z.string().max(100).nullable(),
    /** 未启用的原因（如缺少配置），启用时为 null */
    reason: z.string().max(200).nullable(),
    dailyLimit: z.number().int().min(0),
    usedToday: z.number().int().min(0),
    remaining: z.number().int().min(0),
    maxOutputTokens: z.number().int().min(1),
  })
  .strict();
export type AiStatusResponse = z.infer<typeof AiStatusResponseSchema>;
