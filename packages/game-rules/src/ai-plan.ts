import {
  AI_LIMITS,
  AI_RISK_TAGS,
  AI_STEP_TYPES,
  AiActionPlanSchema,
  EntityIdSchema,
  type AiActionPlan,
  type AiActionType,
  type AiTarget,
  type AiTargetType,
} from '@jhz/contracts';
import { isKnownItem, pillGradeOf } from './items.js';
import { isLocationId, isNpcId } from './world.js';

/* ------------------------------------------------------------------ */
/* 1. 从模型原文中提取 JSON                                             */
/* ------------------------------------------------------------------ */

export type ExtractResult = { ok: true; value: unknown } | { ok: false; code: 'EMPTY' | 'TOO_LONG' | 'NOT_JSON' };

/** 从字符串里按「字符串感知」的方式取出第一个配平的 {...} */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** 弱模型常见的格式小问题：尾逗号、中文引号、单引号 */
function repairs(candidate: string): string[] {
  const noTrailingComma = candidate.replace(/,\s*([}\]])/g, '$1');
  const asciiQuotes = candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const out = [noTrailingComma, asciiQuotes, asciiQuotes.replace(/,\s*([}\]])/g, '$1')];
  if (!candidate.includes('"') && candidate.includes("'")) out.push(candidate.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1'));
  return out;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/**
 * 宽容地提取 JSON：支持 Markdown 代码围栏、前后多余的话、尾逗号、中文引号。
 * 仅做格式整理，不改变语义；超长原文直接拒绝。永不抛出异常。
 */
export function extractJson(raw: string): ExtractResult {
  const text = raw.replace(/^﻿/, '').trim();
  if (text === '') return { ok: false, code: 'EMPTY' };
  if (text.length > AI_LIMITS.rawMax) return { ok: false, code: 'TOO_LONG' };

  const candidates: string[] = [text];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  const braced = firstBalancedObject(text);
  if (braced) candidates.push(braced);

  for (const c of candidates) {
    const direct = tryParse(c);
    if (direct.ok) return direct;
  }
  for (const c of candidates) {
    for (const fixed of repairs(c)) {
      const r = tryParse(fixed);
      if (r.ok) return r;
    }
  }
  return { ok: false, code: 'NOT_JSON' };
}

/* ------------------------------------------------------------------ */
/* 2. 规范化：把「差不多对」的输出整理成严格 schema 的样子              */
/* ------------------------------------------------------------------ */

const KEY_ALIASES: Record<string, string> = {
  actiontype: 'action_type',
  action: 'action_type',
  intention: 'intent',
  object: 'target',
  risks: 'risk_tags',
  risktags: 'risk_tags',
  context: 'narrative_context',
  narrativecontext: 'narrative_context',
  narrative: 'narrative_context',
  needsclarification: 'needs_clarification',
  need_clarification: 'needs_clarification',
  clarify: 'needs_clarification',
  question: 'clarification',
};

const ACTION_SYNONYMS: [RegExp, AiActionType][] = [
  [/^(cultivate|cultivation|train|meditate|修炼|练功|打坐|修行)$/, 'cultivate'],
  [/^(rest|sleep|relax|休息|歇息|睡觉|歇一歇)$/, 'rest'],
  [/^(breakthrough|break_through|breakthru|突破|冲关|破境)$/, 'breakthrough'],
  [/^(start_idle|idle_start|start_cultivation|开始挂机|开始放置修炼|放置修炼|挂机)$/, 'start_idle'],
  [/^(stop_idle|idle_stop|stop_cultivation|停止挂机|停止放置修炼|停止修炼|结束修炼)$/, 'stop_idle'],
  [/^(check_status|status|inspect_self|查看状态|查看|状态|属性)$/, 'check_status'],
  [/^(talk|chat|speak|dialogue|交谈|对话|聊天|说话)$/, 'talk'],
  [/^(travel|move|go|goto|go_to|walk|前往|去|移动|走|赶路|去往)$/, 'travel'],
  [/^(custom|custom_action|自定义|自定义行为|自由行动)$/, 'custom'],
  [/^(other|unknown|none|其他|不明)$/, 'other'],
];

const TARGET_TYPE_SYNONYMS: [RegExp, AiTargetType][] = [
  [/^(item|物品|道具|东西)$/, 'item'],
  [/^(npc|person|人物|人|角色)$/, 'npc'],
  [/^(location|place|地点|位置|地方)$/, 'location'],
];

/** 这些动作不需要目标：模型多写的目标直接丢弃（不参与结算，丢弃是安全的） */
const NO_TARGET_ACTIONS: ReadonlySet<AiActionType> = new Set(['cultivate', 'rest', 'start_idle', 'stop_idle', 'check_status', 'custom', 'other']);

const DEFAULT_CLARIFICATION = '没太明白你想做什么，可以换个说法，比如「修炼」「休息」或「突破」。';

const snake = (k: string) => k.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();

/** 去掉控制字符、折叠空白、截断到上限（截断是安全的整理，不改变语义结构） */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, max).join('');
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return ['true', '是', 'yes', '1'].includes(v.trim().toLowerCase());
  return false;
}

function normalizeActionType(v: unknown): AiActionType | null {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (k === '') return null;
  for (const [re, t] of ACTION_SYNONYMS) if (re.test(k)) return t;
  return 'other'; // 说了但认不出来：归为 other，走澄清，而不是猜
}

const isNone = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && ['', 'none', 'null', 'n/a', '无'].includes(v.trim().toLowerCase()));

type TargetNorm = { kind: 'none' } | { kind: 'ok'; target: AiTarget } | { kind: 'illegal' };

function inferType(id: string): AiTargetType | null {
  if (id.startsWith('npc_')) return 'npc';
  if (id.startsWith('loc_')) return 'location';
  if (isKnownItem(id) || id.startsWith('pill_') || id.startsWith('item_')) return 'item';
  return null;
}

function normalizeTarget(v: unknown): TargetNorm {
  if (isNone(v)) return { kind: 'none' };
  let typeRaw: unknown;
  let idRaw: unknown;
  if (typeof v === 'string') {
    idRaw = v;
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    const m = new Map(Object.entries(v as Record<string, unknown>).map(([k, x]) => [snake(k), x]));
    typeRaw = m.get('type');
    idRaw = m.get('id');
    if (typeof typeRaw === 'string' && ['none', 'null', ''].includes(typeRaw.trim().toLowerCase()) && isNone(idRaw)) return { kind: 'none' };
  } else {
    return { kind: 'illegal' };
  }
  if (typeof idRaw !== 'string') return { kind: 'illegal' };
  const id = idRaw.trim().toLowerCase();
  if (!EntityIdSchema.safeParse(id).success) return { kind: 'illegal' }; // 含空格、引号、分号、路径等一律拒绝

  let type: AiTargetType | null = null;
  if (typeof typeRaw === 'string') {
    const k = typeRaw.trim().toLowerCase();
    type = TARGET_TYPE_SYNONYMS.find(([re]) => re.test(k))?.[1] ?? null;
    if (!type) return { kind: 'illegal' };
  } else {
    type = inferType(id);
    if (!type) return { kind: 'illegal' };
  }
  return { kind: 'ok', target: { type, id } };
}

function normalizeSteps(v: unknown): AiActionPlan['steps'] {
  if (!Array.isArray(v)) return [];
  const out: AiActionPlan['steps'] = [];
  for (const s of v) {
    if (out.length >= AI_LIMITS.stepsMax) break;
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const m = new Map(Object.entries(s as Record<string, unknown>).map(([k, x]) => [snake(k), x]));
    const type = typeof m.get('type') === 'string' ? (m.get('type') as string).trim().toLowerCase() : '';
    if (!(AI_STEP_TYPES as readonly string[]).includes(type)) continue; // 未知步骤丢弃
    const raw = m.get('target_id') ?? m.get('destination_id') ?? m.get('target');
    const id = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    out.push({ type: type as AiActionPlan['steps'][number]['type'], target_id: id && EntityIdSchema.safeParse(id).success ? id : null });
  }
  return out;
}

function normalizeRiskTags(v: unknown): AiActionPlan['risk_tags'] {
  if (!Array.isArray(v)) return [];
  const known = new Set<string>(AI_RISK_TAGS);
  const out = new Set<AiActionPlan['risk_tags'][number]>();
  for (const t of v) {
    const k = typeof t === 'string' ? t.trim().toLowerCase() : '';
    if (known.has(k)) out.add(k as AiActionPlan['risk_tags'][number]);
    if (out.size >= AI_LIMITS.riskTagsMax) break;
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* 3. 对外入口                                                          */
/* ------------------------------------------------------------------ */

export type PlanParseCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'NOT_JSON'
  | 'NOT_OBJECT'
  | 'MISSING_ACTION_TYPE'
  | 'ILLEGAL_TARGET'
  | 'SCHEMA_INVALID';

export type PlanParseResult =
  | { ok: true; plan: AiActionPlan; /** 规范化时做过的整理，便于审计与排查 */ notes: string[] }
  | { ok: false; code: PlanParseCode; message: string };

const fail = (code: PlanParseCode, message: string): PlanParseResult => ({ ok: false, code, message });

/**
 * 解析并规范化模型输出。永不抛出异常；返回的方案一定通过严格 schema。
 * - 未知字段、未知步骤、未知风险标签：丢弃（并记入 notes），绝不执行；
 * - 缺失 action_type、目标格式非法（含注入式内容）、整体不是对象：拒绝；
 * - fallbackIntent：模型漏写 intent 时，用玩家的原话代替。
 */
export function parseAiPlan(raw: string, opts: { fallbackIntent?: string } = {}): PlanParseResult {
  const ex = extractJson(typeof raw === 'string' ? raw : '');
  if (!ex.ok) {
    return fail(ex.code, ex.code === 'EMPTY' ? '模型没有返回内容' : ex.code === 'TOO_LONG' ? '模型返回内容过长' : '模型返回的内容不是有效的 JSON');
  }
  const v = ex.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('NOT_OBJECT', '模型返回的不是一个对象');

  const notes: string[] = [];
  const fields = new Map<string, unknown>();
  const dropped: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = KEY_ALIASES[snake(k)] ?? KEY_ALIASES[snake(k).replace(/_/g, '')] ?? snake(k);
    if (['action_type', 'intent', 'target', 'steps', 'risk_tags', 'narrative_context', 'needs_clarification', 'clarification'].includes(key)) {
      if (!fields.has(key)) fields.set(key, val);
    } else {
      dropped.push(k.slice(0, 32));
    }
  }
  if (dropped.length > 0) notes.push(`丢弃未知字段：${dropped.slice(0, 8).join('、')}`);

  const actionType = normalizeActionType(fields.get('action_type'));
  if (!actionType) return fail('MISSING_ACTION_TYPE', '模型没有给出动作类型');

  let target: AiTarget | null = null;
  const tn = normalizeTarget(fields.get('target'));
  if (NO_TARGET_ACTIONS.has(actionType)) {
    if (tn.kind !== 'none') notes.push('该动作不需要目标，已丢弃');
  } else if (tn.kind === 'illegal') {
    return fail('ILLEGAL_TARGET', '目标格式不合法');
  } else if (tn.kind === 'ok') {
    target = tn.target;
  }

  let needsClarification = asBool(fields.get('needs_clarification')) || actionType === 'other';
  let clarification: string | null = cleanText(fields.get('clarification'), AI_LIMITS.clarificationMax) || null;
  if (needsClarification && !clarification) clarification = DEFAULT_CLARIFICATION;
  if (!needsClarification) clarification = null;
  const intent = cleanText(fields.get('intent'), AI_LIMITS.intentMax) || cleanText(opts.fallbackIntent, AI_LIMITS.intentMax);
  if (!intent) return fail('SCHEMA_INVALID', '模型没有给出意图，且没有可用的玩家原话');
  if (!fields.has('intent') || cleanText(fields.get('intent'), 1) === '') notes.push('缺少 intent，已用玩家原话代替');

  const candidate = {
    intent,
    action_type: actionType,
    target,
    steps: normalizeSteps(fields.get('steps')),
    risk_tags: normalizeRiskTags(fields.get('risk_tags')),
    narrative_context: cleanText(fields.get('narrative_context'), AI_LIMITS.contextMax),
    needs_clarification: needsClarification,
    clarification,
  };
  const checked = AiActionPlanSchema.safeParse(candidate);
  if (!checked.success) return fail('SCHEMA_INVALID', `方案不符合格式：${checked.error.issues[0]?.path.join('.') ?? ''}`);
  return { ok: true, plan: checked.data, notes };
}

/* ------------------------------------------------------------------ */
/* 4. 目标校验：目标必须是已存在的实体，否则进入澄清                    */
/* ------------------------------------------------------------------ */

/** 世界里存在哪些实体 */
export interface EntityCatalog {
  itemExists(id: string): boolean;
  npcExists(id: string): boolean;
  locationExists(id: string): boolean;
}

export const defaultCatalog: EntityCatalog = {
  itemExists: isKnownItem,
  npcExists: isNpcId,
  locationExists: isLocationId,
};

export type TargetCheck = { ok: true } | { ok: false; reason: 'UNKNOWN_ENTITY' | 'TARGET_NOT_ALLOWED'; clarification: string };

/** 校验方案里的目标；不通过时给出一句话的澄清，调用方据此走澄清流程而不是执行 */
export function checkPlanTarget(plan: AiActionPlan, catalog: EntityCatalog = defaultCatalog): TargetCheck {
  const t = plan.target;
  if (plan.action_type === 'travel') {
    if (!t) return { ok: false, reason: 'TARGET_NOT_ALLOWED', clarification: '你想去哪里？' };
    if (t.type !== 'location') return { ok: false, reason: 'TARGET_NOT_ALLOWED', clarification: '只能前往某个地点，你想去哪里？' };
  }
  if (!t) return { ok: true };
  const exists = t.type === 'item' ? catalog.itemExists(t.id) : t.type === 'npc' ? catalog.npcExists(t.id) : catalog.locationExists(t.id);
  if (!exists) return { ok: false, reason: 'UNKNOWN_ENTITY', clarification: '我没找到你说的那个对象，可以说得更具体些吗？' };
  if (plan.action_type === 'breakthrough' && !(t.type === 'item' && pillGradeOf(t.id) !== null)) {
    return { ok: false, reason: 'TARGET_NOT_ALLOWED', clarification: '这个东西不能用来突破，突破只能搭配突破丹药。' };
  }
  return { ok: true };
}

