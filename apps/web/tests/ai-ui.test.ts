import { describe, expect, it } from 'vitest';
import type { AiStatusResponse, LogRecord } from '@jhz/contracts';
import { FREE_HINTS, aiView } from '../src/ai';
import { mergeEntries, replaceEntries, toLogEntries } from '../src/log';

const status = (patch: Partial<AiStatusResponse> = {}): AiStatusResponse => ({
  enabled: true,
  provider: 'mock',
  model: 'm',
  reason: null,
  dailyLimit: 200,
  usedToday: 10,
  remaining: 190,
  maxOutputTokens: 1000,
  ...patch,
});
const rec = (patch: Partial<LogRecord> = {}): LogRecord => ({
  id: 7,
  at: 0,
  type: 'breakthrough',
  narrative: '模板叙事',
  changes: [],
  breakthrough: { outcome: 'success', chancePercent: 80, roll: 0, pillName: null, realmFrom: 'body_tempering', realmTo: 'opening' },
  idle: null,
  note: null,
  ...patch,
});

describe('aiView：状态点与输入框可用性', () => {
  it('正常', () => expect(aiView(status(), false)).toMatchObject({ state: 'ok', label: 'AI 正常', canInput: true, reason: null }));
  it('未开启：灰点，不能输入，给出原因', () => {
    const v = aiView(status({ enabled: false, remaining: 0 }), false);
    expect(v).toMatchObject({ state: 'off', label: 'AI 未开启', canInput: false });
    expect(v.reason).toContain('固定选项');
  });
  it('当日次数用完：黄点，不能输入', () => {
    const v = aiView(status({ remaining: 0 }), false);
    expect(v).toMatchObject({ state: 'warn', label: 'AI 次数用完', canInput: false });
    expect(v.reason).toContain('明天');
  });
  it('刚刚调用失败：黄点，但仍可输入（可能只是临时故障）', () => expect(aiView(status(), true)).toMatchObject({ state: 'warn', label: 'AI 暂不可用', canInput: true }));
  it('状态接口读取失败：不阻止输入，由服务端决定', () => expect(aiView(null, false)).toMatchObject({ state: 'warn', canInput: true }));
  it('未开启优先于「刚刚失败」', () => expect(aiView(status({ enabled: false }), true).state).toBe('off'));
});

describe('快捷短句', () => {
  it('不含数值或会被误读为指令的内容，长度远低于输入上限', () => {
    for (const h of FREE_HINTS) {
      expect(h.length).toBeLessThan(20);
      expect(h).not.toMatch(/[0-9]/);
    }
  });
});

describe('叙事待补的日志条目', () => {
  it('pending 记录带出行动 ID；已完成或旧记录没有标记', () => {
    expect(toLogEntries(rec({ narration: { actionId: 'a-1', pending: true } }))[0]!.pendingNarration).toEqual({ actionId: 'a-1' });
    expect(toLogEntries(rec({ narration: { actionId: 'a-1', pending: false } }))[0]!.pendingNarration).toBeUndefined();
    expect(toLogEntries(rec())[0]!.pendingNarration).toBeUndefined();
    expect(toLogEntries(rec({ narration: null }))[0]!.pendingNarration).toBeUndefined();
  });

  it('replaceEntries：同 key 的条目被换成新文字并去掉标记；顺序与数量不变；mergeEntries 不会覆盖已有条目', () => {
    const before = toLogEntries(rec({ narration: { actionId: 'a-1', pending: true } }));
    const other = toLogEntries(rec({ id: 8, narrative: '另一条' }));
    const list = mergeEntries([], [...before, ...other]);
    const after = toLogEntries(rec({ narrative: '新叙事', narration: { actionId: 'a-1', pending: false } }));
    expect(mergeEntries(list, after)[0]!.text).toBe('模板叙事'); // 去重：不会因为重放覆盖
    const replaced = replaceEntries(list, after);
    expect(replaced.map((e) => e.text)).toEqual(['新叙事', '另一条']);
    expect(replaced[0]!.pendingNarration).toBeUndefined();
    expect(replaceEntries(list, toLogEntries(rec({ id: 99 })))).toEqual(list); // 没有对应条目则忽略
  });
});
