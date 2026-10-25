import { z } from 'zod';

/**
 * AI 行动方案：模型把玩家的自然语言转成的「结构化意图」。
 *
 * 信任边界：这是不可信输入。方案里没有任何数值字段（银两、伤害、成功率、经验……），
 * 模型无从提交；所有结算由服务端规则函数完成。前置条件（体力、冷却、库存等）也不由模型声明，
 * 一律由服务端根据当前状态计算。
 */
export const AI_ACTION_TYPES = [
  'cultivate', // 修炼（固定行动）
  'rest', // 休息（固定行动）
  'breakthrough', // 突破，可带一枚丹药
  'start_idle', // 开始放置修炼
  'stop_idle', // 停止放置修炼
  'check_status', // 查看状态
  'talk', // 与人交谈（第一次见面会留下记忆）
  'travel', // 前往相邻地点（目标为地点；相邻与体力由服务端判定）
  'other', // 无法归类或暂不支持，进入澄清
] as const;
export const AiActionTypeSchema = z.enum(AI_ACTION_TYPES);
export type AiActionType = z.infer<typeof AiActionTypeSchema>;

export const AI_TARGET_TYPES = ['item', 'npc', 'location'] as const;
export const AiTargetTypeSchema = z.enum(AI_TARGET_TYPES);
export type AiTargetType = z.infer<typeof AiTargetTypeSchema>;

/** 实体 ID：小写字母、数字、下划线；不得是显示名称 */
export const EntityIdSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const AiTargetSchema = z.object({ type: AiTargetTypeSchema, id: EntityIdSchema }).strict();
export type AiTarget = z.infer<typeof AiTargetSchema>;

export const AI_STEP_TYPES = ['travel', 'dialogue', 'inspect'] as const;
export const AiStepSchema = z
  .object({ type: z.enum(AI_STEP_TYPES), target_id: EntityIdSchema.nullable() })
  .strict();

export const AI_RISK_TAGS = ['reputation', 'injury', 'cost', 'time'] as const;

export const AI_LIMITS = {
  /** 供解析的模型原文最大长度（超长直接拒绝，避免被灌入大段内容） */
  rawMax: 8000,
  intentMax: 80,
  contextMax: 120,
  clarificationMax: 100,
  stepsMax: 3,
  riskTagsMax: 4,
} as const;

export const AiActionPlanSchema = z
  .object({
    /** 对玩家意图的一句话复述 */
    intent: z.string().min(1).max(AI_LIMITS.intentMax),
    action_type: AiActionTypeSchema,
    target: AiTargetSchema.nullable(),
    steps: z.array(AiStepSchema).max(AI_LIMITS.stepsMax),
    risk_tags: z.array(z.enum(AI_RISK_TAGS)).max(AI_LIMITS.riskTagsMax),
    /** 供叙事生成参考的一句背景，不参与任何结算 */
    narrative_context: z.string().max(AI_LIMITS.contextMax),
    needs_clarification: z.boolean(),
    clarification: z.string().min(1).max(AI_LIMITS.clarificationMax).nullable(),
  })
  .strict()
  .refine((p) => !p.needs_clarification || p.clarification !== null, {
    message: '需要澄清时必须给出澄清问题',
    path: ['clarification'],
  });
export type AiActionPlan = z.infer<typeof AiActionPlanSchema>;
