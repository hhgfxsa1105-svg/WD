import { describe, expect, it } from 'vitest';
import type { QuestView } from '@jhz/contracts';
import { toLogEntries } from '../src/log';
import { affinityBar, attitudeText, currentStep, deltaText, questNeedsAttention, questStatusLabel } from '../src/npc';

const q = (over: Partial<QuestView> = {}): QuestView => ({
  id: 'quest_x',
  name: '测试',
  summary: '',
  giver: null,
  status: 'available',
  steps: [{ text: 'a', done: false }, { text: 'b', done: false }],
  reward: [],
  claimed: false,
  lockedBy: null,
  ...over,
});

describe('attitudeText', () => {
  it.each([
    [{ affinity: 80, trust: 50, hostility: 0 }, '亲近'],
    [{ affinity: 60, trust: 50, hostility: 0 }, '亲近'],
    [{ affinity: 59, trust: 50, hostility: 0 }, '友善'],
    [{ affinity: 10, trust: 20, hostility: 0 }, '友善'],
    [{ affinity: 9, trust: 20, hostility: 0 }, '平淡'],
    [{ affinity: -9, trust: 20, hostility: 0 }, '平淡'],
    [{ affinity: -10, trust: 20, hostility: 0 }, '冷淡'],
    [{ affinity: -40, trust: 0, hostility: 0 }, '厌恶'],
    [{ affinity: 90, trust: 90, hostility: 50 }, '敌视'], // 敌意优先
  ])('%j → %s', (r, text) => expect(attitudeText(r)).toBe(text));
});

describe('deltaText', () => {
  it('只列有变化的项，带正负号', () => {
    expect(deltaText({ affinity: 3, trust: 2, hostility: 0 })).toBe('好感 +3 · 信任 +2');
    expect(deltaText({ affinity: -5, trust: 0, hostility: 4 })).toBe('好感 −5 · 敌意 +4');
    expect(deltaText({ affinity: 0, trust: 0, hostility: 0 })).toBe('无变化');
  });
});

describe('affinityBar：中点为 0', () => {
  it('正值向右、负值向左、0 为空；越界被夹住', () => {
    expect(affinityBar(0)).toEqual({ left: 50, width: 0 });
    expect(affinityBar(40)).toEqual({ left: 50, width: 20 });
    expect(affinityBar(-40)).toEqual({ left: 30, width: 20 });
    expect(affinityBar(100)).toEqual({ left: 50, width: 50 });
    expect(affinityBar(-100)).toEqual({ left: 0, width: 50 });
    expect(affinityBar(999)).toEqual({ left: 50, width: 50 });
    expect(affinityBar(-999)).toEqual({ left: 0, width: 50 });
  });
});

describe('任务展示', () => {
  it('状态文字：已完成且已领取显示「已领取」', () => {
    expect(questStatusLabel(q({ status: 'locked' }))).toBe('未解锁');
    expect(questStatusLabel(q({ status: 'available' }))).toBe('可接取');
    expect(questStatusLabel(q({ status: 'active' }))).toBe('进行中');
    expect(questStatusLabel(q({ status: 'completed' }))).toBe('已完成');
    expect(questStatusLabel(q({ status: 'completed', claimed: true }))).toBe('已领取');
    expect(questStatusLabel(q({ status: 'failed' }))).toBe('已失败');
  });
  it('红点：有可接取或已完成未领取的任务才亮', () => {
    expect(questNeedsAttention([])).toBe(false);
    expect(questNeedsAttention([q({ status: 'locked' }), q({ status: 'active' }), q({ status: 'failed' })])).toBe(false);
    expect(questNeedsAttention([q({ status: 'completed', claimed: true })])).toBe(false);
    expect(questNeedsAttention([q({ status: 'available' })])).toBe(true);
    expect(questNeedsAttention([q({ status: 'completed', claimed: false })])).toBe(true);
  });
  it('当前步骤：进行中的任务指向第一个没完成的步骤，其余状态为 −1', () => {
    expect(currentStep(q({ status: 'active' }))).toBe(0);
    expect(currentStep(q({ status: 'active', steps: [{ text: 'a', done: true }, { text: 'b', done: false }] }))).toBe(1);
    expect(currentStep(q({ status: 'active', steps: [{ text: 'a', done: true }, { text: 'b', done: true }] }))).toBe(-1);
    expect(currentStep(q({ status: 'available' }))).toBe(-1);
  });
});

describe('系统日志条目也显示数值变化（如任务奖励）', () => {
  it('system 记录的 changes 渲染为标签，note 作为小字', () => {
    const [e] = toLogEntries({ id: 9, at: 0, type: 'system', narrative: '任务「初入山门」完成，获得：铜钱 100。', changes: [{ stat: 'copper', delta: 100 }], breakthrough: null, idle: null, note: '赵铁牛笑了。' });
    expect(e!.chips).toEqual([{ text: '铜钱 +100', tone: 'up' }]);
    expect(e!.sub).toBe('赵铁牛笑了。');
    expect(e!.system).toBe(true);
    const [plain] = toLogEntries({ id: 10, at: 0, type: 'system', narrative: '任务进度', changes: [], breakthrough: null, idle: null, note: null });
    expect(plain!.chips).toEqual([]);
  });
});
