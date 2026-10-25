import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;

const progress = async (page: Page) => Number(await page.getByRole('progressbar', { name: '晋级进度' }).getAttribute('aria-valuenow'));
const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};
const startIdle = async (page: Page) => {
  await openActions(page);
  await page.getByRole('button', { name: '开始放置修炼' }).click();
  await expect(page.getByText('修炼中')).toBeVisible();
};

test.describe('离线收益（真实离线策略）', () => {
  test.use({ realOffline: true });

  test('离线 2 小时：重新打开页面自动结算，按 50% 效率，日志有离线汇总', async ({ page, server }) => {
    await load(page, server.url);
    await startIdle(page);
    await server.advance(2 * HOUR);
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect.poll(() => progress(page)).toBe(12);
    await expect(page.locator('.entry .sub', { hasText: '离线 2 小时，计入 2 小时（效率 50%）' })).toBeVisible();
  });

  test('离线超过 12 小时：只计入上限，日志注明已达上限；再次领取没有额外收益', async ({ page, server }) => {
    await load(page, server.url);
    await startIdle(page);
    await server.advance(48 * HOUR);
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect.poll(() => progress(page)).toBe(75);
    await expect(page.locator('.entry .sub', { hasText: '离线 48 小时，已达上限，仅计入 12 小时（效率 50%）' })).toBeVisible();

    await openActions(page);
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.getByText('暂无可领取的收益')).toBeVisible();
    expect(await progress(page)).toBe(75);
  });

  test('放置修炼区显示离线规则', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await expect(page.getByLabel('离线规则')).toHaveText('离线最多计入 12 小时，按 50% 效率；修炼时现实 1 小时 = 游戏 1 时辰');
  });

  test('在线（每次接触都会刷新）：分两段各 3 分钟领取，全额且不带离线说明', async ({ page, server }) => {
    await load(page, server.url);
    await startIdle(page);
    await server.advance(3 * MIN);
    await page.getByRole('button', { name: '领取收益' }).click(); // 3 × 0.21 = 0.63，暂无收益，但刷新了接触时间
    await expect(page.getByText('暂无可领取的收益')).toBeVisible();
    await server.advance(3 * MIN);
    await page.getByRole('button', { name: '领取收益' }).click(); // 累计 6 分钟，距上次接触仅 3 分钟：在线全额，6 × 0.21 = 1.26 → +1
    await expect(page.locator('.chip', { hasText: '经验 +1%' })).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '离线' })).toHaveCount(0);
  });
});

test.describe('系统时间异常', () => {
  test('系统时间被调到过去：游戏时间暂停，不产生额外收益，并给出提示', async ({ page, server }) => {
    await load(page, server.url);
    await startIdle(page);
    await server.advance(10 * MIN);
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect.poll(() => progress(page)).toBe(2);

    await server.advance(-24 * HOUR); // 系统时间被调早一天
    await server.advance(30 * MIN); // 之后「过了」30 分钟，但仍早于游戏时间
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.getByText('暂无可领取的收益')).toBeVisible();
    expect(await progress(page)).toBe(2);

    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await openActions(page);
    await expect(page.getByRole('alert').filter({ hasText: '系统时间早于游戏时间' })).toBeVisible();
  });

  test('突破冷却只看游戏时间：现实时间被调早或过去很久都不改变冷却', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0.9999);
    await load(page, server.url);
    await openActions(page);
    await page.locator('.act.bt').click();
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(page.locator('.chip', { hasText: '经验 −20%' })).toBeVisible();

    await server.advance(-48 * HOUR); // 现实时间被调早
    await server.advance(72 * HOUR); // 再过去三天
    await server.setPlayer({ realmProgress: 100 });
    await page.reload();
    await openActions(page);
    await expect(page.locator('.act.bt')).toBeDisabled();
    await expect(page.locator('.act.bt')).toContainText('气息未平');
  });
});
