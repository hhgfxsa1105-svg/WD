import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const MIN = 60_000;
const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const entries = (page: Page) => page.locator('.entry');
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};
const post = (url: string, body: unknown) =>
  fetch(`${url}/api/v1/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test.describe('日志与行动记录持久化', () => {
  test('刷新页面后日志仍在，且顺序不变', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.locator('.act:not(.bt)', { hasText: '修炼' }).click();
    await expect(entries(page)).toHaveCount(2);
    await page.locator('.act:not(.bt)', { hasText: '休息' }).click();
    await expect(entries(page)).toHaveCount(3);

    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(entries(page)).toHaveCount(3);
    await expect(entries(page).nth(1)).toContainText('盘膝');
    await expect(entries(page).nth(2)).toContainText('檐下');
    await expect(entries(page).nth(1).locator('.chip', { hasText: '体力 −10' })).toBeVisible();
  });

  test('重启服务后日志仍在，并继续追加', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.locator('.act:not(.bt)', { hasText: '修炼' }).click();
    await expect(entries(page)).toHaveCount(2);

    await server.restart();
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(entries(page)).toHaveCount(2);

    await openActions(page);
    await page.locator('.act:not(.bt)', { hasText: '休息' }).click();
    await expect(entries(page)).toHaveCount(3);
  });

  test('突破日志（成功率、掷点、丹药）刷新后完整还原', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0);
    await load(page, server.url);
    await openActions(page);
    await page.locator('.act.bt').click();
    await page.getByLabel(/凡阶突破丹/).check();
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(page.locator('.entry .sub', { hasText: '成功率 80%' })).toBeVisible();

    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '成功率 80% · 掷点 0.00 · 消耗凡阶突破丹 ×1' })).toBeVisible();
    await expect(page.locator('.chip', { hasText: '境界 炼体→通窍' })).toBeVisible();
  });

  test('放置修炼的收益日志刷新后仍在，空结算不产生噪声', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.getByRole('button', { name: '开始放置修炼' }).click();
    await expect(page.getByText('修炼中')).toBeVisible();
    await server.advance(10 * MIN);
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.locator('.chip', { hasText: '经验 +2%' })).toBeVisible();
    const count = await entries(page).count();
    // 连续两次空结算：没有收益，不新增日志
    await page.getByRole('button', { name: '领取收益' }).click();
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(entries(page)).toHaveCount(count);

    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '放置修炼 · 结算 10 分钟' })).toBeVisible();
  });
});

test.describe('幂等持久化（接口层）', () => {
  const body = (n: number) => ({ kind: 'fixed', idempotencyKey: `e2e-key-${String(n).padStart(4, '0')}`, actionId: 'cultivate' });

  test('重启服务后用同一个幂等键重试：返回同一结果，不重复结算', async ({ server }) => {
    const first = await (await post(server.url, body(1))).json();
    expect(first.player.stamina).toBe(40);

    await server.restart();
    const replay = await (await post(server.url, body(1))).json();
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.player.stamina).toBe(40);
    expect(replay.log.id).toBe(first.log.id);

    const state = await (await fetch(`${server.url}/api/v1/player/state`)).json();
    expect(state.stamina).toBe(40);
    expect(state.version).toBe(1);
    const log = await (await fetch(`${server.url}/api/v1/log`)).json();
    expect(log.entries).toHaveLength(1);
  });

  test('内部审计接口可查到该行动的前后状态', async ({ server }) => {
    const r = await (await post(server.url, body(2))).json();
    const audit = await (await fetch(`${server.url}/api/v1/audit/actions/${r.actionId}`)).json();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].before).toMatchObject({ stamina: 50 });
    expect(audit.events[0].after).toMatchObject({ stamina: 40 });
  });
});
