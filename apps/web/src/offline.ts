import type { CultivationResponse } from '@jhz/contracts';
import { formatDuration } from './time';

type Offline = NonNullable<CultivationResponse['offline']>;

/** 离线结算的一行说明：「离线 8 小时 20 分，计入 8 小时 20 分（效率 50%）」，触顶时注明 */
export function offlineSummary(o: Offline): string {
  const counted = `计入 ${formatDuration(o.countedMs)}（效率 ${o.efficiencyPercent}%）`;
  return `离线 ${formatDuration(o.gapMs)}，${o.capped ? `已达上限，仅${counted}` : counted}`;
}

/** 离线规则的一句话说明，用于放置修炼区 */
export function offlineRuleText(capMs: number, efficiencyPercent: number): string {
  return `离线最多计入 ${formatDuration(capMs)}，按 ${efficiencyPercent}% 效率；修炼时现实 1 小时 = 游戏 1 时辰`;
}
