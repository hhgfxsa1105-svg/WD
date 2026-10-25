import type { AiError } from './types.js';

/** 给玩家看的 AI 不可用提示；原始错误细节只留在服务端记录里 */
export function friendlyAiMessage(kind: AiError['kind']): string {
  switch (kind) {
    case 'DISABLED':
      return 'AI 功能未开启，请使用固定选项。';
    case 'BUDGET_EXCEEDED':
      return '今天的 AI 次数用完了，请使用固定选项，明天再来。';
    case 'INPUT_TOO_LARGE':
      return '这句话太长了，请精简后再试。';
    case 'AUTH':
    case 'BAD_REQUEST':
      return 'AI 服务的设置有问题，请检查配置，或使用固定选项。';
    default:
      return 'AI 暂时无法响应，请稍后再试，或使用固定选项。';
  }
}
