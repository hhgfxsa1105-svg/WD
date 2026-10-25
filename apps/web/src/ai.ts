import type { AiStatusResponse } from '@jhz/contracts';

export interface AiView {
  state: 'ok' | 'warn' | 'off';
  label: string;
  /** 是否允许在输入框里发送；不允许时 reason 说明原因 */
  canInput: boolean;
  reason: string | null;
}

/** AI 状态点与输入框可用性：status 为 null 表示状态接口读取失败；down 表示刚刚一次调用失败 */
export function aiView(status: AiStatusResponse | null, down: boolean): AiView {
  if (status && !status.enabled) return { state: 'off', label: 'AI 未开启', canInput: false, reason: 'AI 功能未开启，请使用固定选项。' };
  if (status && status.remaining <= 0) return { state: 'warn', label: 'AI 次数用完', canInput: false, reason: '今天的 AI 次数用完了，请使用固定选项，明天再来。' };
  if (down) return { state: 'warn', label: 'AI 暂不可用', canInput: true, reason: null };
  if (!status) return { state: 'warn', label: 'AI 状态未知', canInput: true, reason: null };
  return { state: 'ok', label: 'AI 正常', canInput: true, reason: null };
}

/** 快捷短句：点击只填入输入框，不会直接发送 */
export const FREE_HINTS = ['打坐一会儿', '服丹冲击下一境界', '看看我的状态'] as const;

/** 等待多久后提示「AI 有点慢」 */
export const SLOW_MS = 20_000;
