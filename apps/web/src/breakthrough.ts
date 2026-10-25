import { breakthroughChance, nextRealm } from '@jhz/game-rules';
import type { PlayerState } from '@jhz/contracts';
import { REALM_LABEL } from './labels';
import { formatCountdown } from './time';

export interface BreakthroughView {
  /** 是否可以发起突破 */
  ok: boolean;
  /** 入口副标题 */
  text: string;
  /** 入口标题里的「当前 → 下一境界」；已是最高境界时为 null */
  route: string | null;
}

/** 突破入口的显示状态；判定顺序与服务端一致：最高境界 → 进度 → 冷却（服务端始终是最终裁判） */
export function breakthroughView(p: PlayerState, now: number): BreakthroughView {
  const target = nextRealm(p.realm);
  if (!target) return { ok: false, text: '已臻陆地神仙，再无更高境界', route: null };
  const route = `${REALM_LABEL[p.realm]} → ${REALM_LABEL[target]}`;
  const left = p.breakthroughAvailableAt === null ? 0 : p.breakthroughAvailableAt - now;
  const cooling = left > 0;
  if (p.realmProgress < 100) {
    const base = `进度 ${p.realmProgress}/100，修炼圆满后可突破`;
    return { ok: false, text: cooling ? `${base} · 冷却剩余 ${formatCountdown(left)}` : base, route };
  }
  if (cooling) return { ok: false, text: `气息未平 · 剩余 ${formatCountdown(left)}`, route };
  return { ok: true, text: `可突破 · 成功率约 ${breakthroughChance(p)!.percent}%`, route };
}
