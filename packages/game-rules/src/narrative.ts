/**
 * 叙事质量守卫：AI 生成的叙事只是「文字装饰」，不得携带或暗示任何会与结算事实矛盾的内容。
 * 不合格就整体弃用（由调用方回退到模板叙事），不做局部修补，避免改出新的歧义。
 */
export const NARRATIVE_LIMITS = { min: 8, max: 200 } as const;

export type NarrativeRejection = 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'NUMBERS' | 'SYSTEM_TEXT' | 'CONTRADICTS_OUTCOME';

export type NarrativeVerdict = { ok: true; text: string } | { ok: false; reason: NarrativeRejection };

/** 数字、货币、成功率等：叙事里不能出现任何会被误读为「数值变化」的内容 */
const NUMBERISH = /[0-9０-９%％]|元宝|银两|铜钱|经验|成功率|概率|几率/;
/** 像系统提示、指令、格式标记或链接的内容 */
const SYSTEM_LIKE = /系统|指令|提示词|规则|prompt|system|assistant|ignore|忽略(以上|之前|上述)|作为.{0,4}(AI|人工智能|语言模型)|json|[{}\[\]<>]|```|https?:|\/\//i;
const SAYS_FAILURE = /失败|未能|功亏一篑|不成|无果|惨败|折戟|落败/;
const SAYS_SUCCESS = /成功|突破了|踏入|晋升|晋级|圆满|大成|更进一步|破境而出/;

/** outcome 为 null 表示该事件没有成败之分（修炼、休息） */
export function vetNarrative(raw: string, ctx: { outcome: 'success' | 'failure' | null }): NarrativeVerdict {
  let t = String(raw ?? '')
    .replace(/```[a-z]*/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉整体包裹的引号
  const wrapped = /^[“"'「『](.*)[”"'」』]$/.exec(t);
  if (wrapped) t = wrapped[1]!.trim();
  const len = [...t].length;
  if (len === 0) return { ok: false, reason: 'EMPTY' };
  if (len < NARRATIVE_LIMITS.min) return { ok: false, reason: 'TOO_SHORT' };
  if (len > NARRATIVE_LIMITS.max) return { ok: false, reason: 'TOO_LONG' };
  if (NUMBERISH.test(t)) return { ok: false, reason: 'NUMBERS' };
  if (SYSTEM_LIKE.test(t)) return { ok: false, reason: 'SYSTEM_TEXT' };
  if (ctx.outcome === 'success' && SAYS_FAILURE.test(t)) return { ok: false, reason: 'CONTRADICTS_OUTCOME' };
  if (ctx.outcome === 'failure' && SAYS_SUCCESS.test(t)) return { ok: false, reason: 'CONTRADICTS_OUTCOME' };
  return { ok: true, text: t };
}
