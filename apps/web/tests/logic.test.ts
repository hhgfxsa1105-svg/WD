import { describe, expect, it } from 'vitest';
import { createInitialPlayer } from '@jhz/game-rules';
import type { CultivationJob, PlayerState } from '@jhz/contracts';
import { breakthroughView } from '../src/breakthrough';
import { createKeyStore } from '../src/api/idempotency';
import { idlePreview } from '../src/idle';
import { formatCountdown } from '../src/time';

const NOW = 1_800_000_000_000;
const p = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createInitialPlayer(), ...patch });

describe('formatCountdown', () => {
  it.each([
    [0, '00:00:00'],
    [-5, '00:00:00'],
    [1, '00:00:01'],
    [1000, '00:00:01'],
    [1001, '00:00:02'],
    [61_000, '00:01:01'],
    [86_399_000, '23:59:59'],
    [86_400_000, '24:00:00'],
  ])('%i ms → %s', (ms, text) => expect(formatCountdown(ms)).toBe(text));
});

describe('breakthroughView', () => {
  it('进度未满：显示进度，不可突破', () => {
    const v = breakthroughView(p({ realmProgress: 40 }), NOW);
    expect(v).toMatchObject({ ok: false, route: '炼体 → 通窍' });
    expect(v.text).toBe('进度 40/100，修炼圆满后可突破');
  });

  it('进度满且无冷却：可突破并显示成功率', () => {
    const v = breakthroughView(p({ realmProgress: 100 }), NOW);
    expect(v.ok).toBe(true);
    expect(v.text).toBe('可突破 · 成功率约 70%');
  });

  it('冷却中：显示倒计时；恰好到点后可用', () => {
    const cool = p({ realmProgress: 100, breakthroughAvailableAt: NOW + 3_661_000 });
    expect(breakthroughView(cool, NOW)).toMatchObject({ ok: false, text: '气息未平 · 剩余 01:01:01' });
    expect(breakthroughView(cool, NOW + 3_661_000).ok).toBe(true);
  });

  it('失败后进度回落且仍在冷却：两条信息都显示', () => {
    const v = breakthroughView(p({ realmProgress: 80, breakthroughAvailableAt: NOW + 60_000 }), NOW);
    expect(v.ok).toBe(false);
    expect(v.text).toBe('进度 80/100，修炼圆满后可突破 · 冷却剩余 00:01:00');
  });

  it('最高境界：没有下一境界', () => {
    const v = breakthroughView(p({ realm: 'land_immortal', neili: { current: 0, max: 300 }, realmProgress: 100 }), NOW);
    expect(v).toMatchObject({ ok: false, route: null });
  });
});

describe('idlePreview', () => {
  const job: CultivationJob = { methodId: 'basic_breathing', status: 'running', startedAt: NOW, lastSettledAt: NOW };
  it('按已累计分钟计算可领取经验（与服务端同一规则）', () => {
    expect(idlePreview(p(), job, NOW + 10 * 60_000)).toEqual({ minutes: 10, progressGain: 2 });
    expect(idlePreview(p(), job, NOW + 4 * 60_000)).toEqual({ minutes: 4, progressGain: 0 });
  });
  it('时钟早于结算点时为 0；进度封顶', () => {
    expect(idlePreview(p(), job, NOW - 1000)).toEqual({ minutes: 0, progressGain: 0 });
    expect(idlePreview(p({ realmProgress: 99 }), job, NOW + 600 * 60_000).progressGain).toBe(1);
  });
});

describe('幂等键仓库', () => {
  it('同一操作重试复用同一个键，清除后换新键', () => {
    let n = 0;
    const s = createKeyStore(() => `key-${++n}`);
    expect(s.keyFor('bt:pill')).toBe('key-1');
    expect(s.keyFor('bt:pill')).toBe('key-1'); // 网络失败后的重试
    expect(s.keyFor('bt:none')).toBe('key-2'); // 不同参数是不同操作
    s.clear('bt:pill');
    expect(s.keyFor('bt:pill')).toBe('key-3');
  });
});

import { offlineRuleText, offlineSummary } from '../src/offline';
import { formatDuration } from '../src/time';

describe('formatDuration', () => {
  it.each([
    [0, '不足 1 分钟'],
    [59_999, '不足 1 分钟'],
    [60_000, '1 分钟'],
    [45 * 60_000, '45 分钟'],
    [3_600_000, '1 小时'],
    [8 * 3_600_000 + 20 * 60_000, '8 小时 20 分'],
    [12 * 3_600_000, '12 小时'],
    [-5, '不足 1 分钟'],
  ])('%i ms → %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe('离线说明', () => {
  it('未触顶：显示离线时长、计入时长与效率', () => {
    expect(offlineSummary({ gapMs: 7_200_000, countedMs: 7_200_000, capped: false, efficiencyPercent: 50 })).toBe(
      '离线 2 小时，计入 2 小时（效率 50%）',
    );
  });
  it('触顶：注明已达上限', () => {
    expect(offlineSummary({ gapMs: 48 * 3_600_000, countedMs: 12 * 3_600_000, capped: true, efficiencyPercent: 50 })).toBe(
      '离线 48 小时，已达上限，仅计入 12 小时（效率 50%）',
    );
  });
  it('规则一句话', () => {
    expect(offlineRuleText(12 * 3_600_000, 50)).toBe('离线最多计入 12 小时，按 50% 效率');
  });
});
