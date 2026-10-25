import { describe, expect, it } from 'vitest';
import { createInitialPlayer } from '@jhz/game-rules';
import type { CultivationJob, PlayerState } from '@jhz/contracts';
import { breakthroughView } from '../src/breakthrough';
import { createKeyStore } from '../src/api/idempotency';
import { idlePreview } from '../src/idle';
import { formatCountdown } from '../src/time';

const NOW = 10_000; // 游戏分钟
const p = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createInitialPlayer(), ...patch });

describe('日志时间标记（游戏时间）', () => {
  it('取自事件发生时的游戏时间：时辰 + 完整日期作提示；与日志序号无关', () => {
    const a = toLogEntries(rec({ id: 1, gameMinutes: 7 * 60 }))[0]!;
    const b = toLogEntries(rec({ id: 99, gameMinutes: 7 * 60 }))[0]!;
    expect(a).toMatchObject({ time: '辰时', timeTitle: '第 1 天 · 辰时' });
    expect(b.time).toBe(a.time);
    expect(toLogEntries(rec({ gameMinutes: 1440 + 13 * 60 }))[0]).toMatchObject({ time: '未时', timeTitle: '第 2 天 · 未时' });
  });
  it('旧记录没有游戏时间：不显示时辰，也不编造', () => {
    expect(toLogEntries(rec({ gameMinutes: null }))[0]).toMatchObject({ time: '' });
    expect(toLogEntries(rec({ gameMinutes: null }))[0]!.timeTitle).toBeUndefined();
  });
  it('欢迎语停在游戏起点', () => {
    expect(WELCOME.time).toBe('辰时');
  });
});

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

  it('冷却中：按游戏时间显示剩余；恰好到点后可用', () => {
    const cool = p({ realmProgress: 100, breakthroughAvailableAt: NOW + 61 });
    expect(breakthroughView(cool, NOW)).toMatchObject({ ok: false, text: '气息未平 · 还需 1 小时 1 分钟' });
    expect(breakthroughView(cool, NOW + 61).ok).toBe(true);
  });

  it('失败后进度回落且仍在冷却：两条信息都显示', () => {
    const v = breakthroughView(p({ realmProgress: 80, breakthroughAvailableAt: NOW + 90 }), NOW);
    expect(v.ok).toBe(false);
    expect(v.text).toBe('进度 80/100，修炼圆满后可突破 · 冷却剩余 1 小时 30 分钟');
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
    expect(offlineRuleText(12 * 3_600_000, 50)).toBe('离线最多计入 12 小时，按 50% 效率；离线 1 小时 = 游戏 1 时辰');
  });
});

import type { LogRecord } from '@jhz/contracts';
import { formatChanges } from '../src/changes';
import { WELCOME, mergeEntries, toLogEntries } from '../src/log';

const rec = (over: Partial<LogRecord>): LogRecord => ({
  id: 3,
  at: 1,
  gameMinutes: null,
  type: 'fixed',
  narrative: '叙事',
  changes: [],
  breakthrough: null,
  idle: null,
  note: null,
  ...over,
});

describe('formatChanges 容错', () => {
  it('忽略未知项目与 0', () => {
    expect(formatChanges([{ stat: 'mystery', delta: 5 }, { stat: 'hp', delta: 0 }, { stat: 'hp', delta: -3 }])).toEqual([{ text: '气血 −3', tone: 'down' }]);
  });
});

describe('toLogEntries：把服务端记录渲染为界面条目', () => {
  it('固定行动：叙事 + 数值标签', () => {
    const [e] = toLogEntries(rec({ changes: [{ stat: 'stamina', delta: -10 }] }));
    expect(e).toMatchObject({ key: '3', seq: 3, text: '叙事', chips: [{ text: '体力 −10', tone: 'down' }] });
  });

  it('突破成功：境界标签替代「经验 −100%」，小字含成功率、掷点、丹药', () => {
    const [e] = toLogEntries(
      rec({
        type: 'breakthrough',
        changes: [{ stat: 'realmProgress', delta: -100 }, { stat: 'maxHp', delta: 30 }],
        breakthrough: { outcome: 'success', chancePercent: 80, roll: 12.3, pillName: '凡阶突破丹', realmFrom: 'body_tempering', realmTo: 'opening' },
      }),
    );
    expect(e!.chips.map((c) => c.text)).toEqual(['境界 炼体→通窍', '气血上限 +30']);
    expect(e!.sub).toBe('成功率 80% · 掷点 12.30 · 消耗凡阶突破丹 ×1');
  });

  it('突破失败：保留经验回落，注明冷却', () => {
    const [e] = toLogEntries(
      rec({
        type: 'breakthrough',
        changes: [{ stat: 'realmProgress', delta: -20 }, { stat: 'hp', delta: -20 }],
        breakthrough: { outcome: 'failure', chancePercent: 70, roll: 90, pillName: null, realmFrom: 'body_tempering', realmTo: 'body_tempering' },
      }),
    );
    expect(e!.chips.map((c) => c.text)).toEqual(['经验 −20%', '气血 −20']);
    expect(e!.sub).toBe('成功率 70% · 掷点 90.00 · 冷却 24 游戏小时');
  });

  it('放置修炼：有收益显示结算分钟与离线说明；无收益的离线单独说明', () => {
    const off = { gapMs: 7_200_000, countedMs: 7_200_000, capped: false, efficiencyPercent: 50 };
    const [a] = toLogEntries(rec({ type: 'idle', changes: [{ stat: 'realmProgress', delta: 12 }], idle: { ticks: 115, offline: off } }));
    expect(a!.sub).toBe('放置修炼 · 结算 115 分钟 · 离线 2 小时，计入 2 小时（效率 50%）');
    const [b] = toLogEntries(rec({ type: 'idle', narrative: '你离开了一阵', idle: { ticks: 0, offline: off } }));
    expect(b!.sub).toBe('离线 2 小时，计入 2 小时（效率 50%） · 收益不足 1% 经验');
  });

  it('修炼圆满：派生出附加的系统条目，键唯一', () => {
    const es = toLogEntries(rec({ id: 9, type: 'idle', changes: [{ stat: 'realmProgress', delta: 1 }], idle: { ticks: 5, offline: null }, note: '修炼已圆满，可以尝试突破了' }));
    expect(es).toHaveLength(2);
    expect(es[1]).toMatchObject({ key: '9-note', system: true, sub: '修炼已圆满，可以尝试突破了' });
    expect(new Set(es.map((e) => e.key)).size).toBe(2);
  });
});

describe('mergeEntries', () => {
  it('按 key 去重（幂等回放不重复显示），并保持序号顺序', () => {
    const a = toLogEntries(rec({ id: 2 }));
    const b = toLogEntries(rec({ id: 5 }));
    let list = mergeEntries([WELCOME], [...b, ...a]);
    expect(list.map((e) => e.seq)).toEqual([0, 2, 5]);
    const same = mergeEntries(list, a);
    expect(same).toBe(list); // 没有新条目时返回原数组
    list = mergeEntries(list, toLogEntries(rec({ id: 4 })));
    expect(list.map((e) => e.seq)).toEqual([0, 2, 4, 5]);
  });
});
