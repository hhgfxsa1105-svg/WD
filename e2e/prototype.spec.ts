import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const stamina = async (page: Page) => Number(await page.getByRole('progressbar', { name: '体力' }).getAttribute('aria-valuenow'));
const progress = async (page: Page) => Number(await page.getByRole('progressbar', { name: '晋级进度' }).getAttribute('aria-valuenow'));
const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const cultivate = (page: Page) => page.locator('.act:not(.bt)', { hasText: '修炼' });
const rest = (page: Page) => page.locator('.act:not(.bt)', { hasText: '休息' });

test.beforeEach(async ({ page, server }) => {
  await page.goto(server.url);
  await expect(page.locator('.card')).toBeVisible();
});

test('首页展示角色：炼体无内力、六维、三种货币', async ({ page }) => {
  await expect(page.getByRole('button', { name: '林惊鸿' })).toBeVisible();
  await expect(page.locator('.realm')).toHaveText('炼体');
  await expect(page.getByRole('progressbar', { name: '气血' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '内力' })).toHaveCount(0);
  await expect(page.locator('.six dt')).toHaveText(['神', '力', '敏', '根', '悟', '福']);
  await expect(page.locator('.money i')).toHaveText(['元宝', '银两', '铜钱']);
});

test('点击名字展开称号与命格，可用再点、空白处、Esc 收回', async ({ page }) => {
  const name = page.getByRole('button', { name: '林惊鸿' });
  const pop = page.locator('#namePop');
  await name.click();
  await expect(pop).toContainText('初出茅庐');
  await expect(pop).toContainText('七杀');
  await name.click();
  await expect(pop).toHaveCount(0);
  await name.click();
  await page.mouse.click(5, 5);
  await expect(pop).toHaveCount(0);
  await name.click();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});

test('快速连点修炼只结算一次', async ({ page }) => {
  let posts = 0;
  page.on('request', (r) => r.method() === 'POST' && r.url().includes('/api/v1/actions') && posts++);
  await openActions(page);
  await cultivate(page).dblclick();
  await expect(page.locator('.chip').first()).toBeVisible();
  expect(posts).toBe(1);
  expect(await stamina(page)).toBe(40);
});

test('体力耗尽后修炼禁用并提示，休息后恢复', async ({ page }) => {
  await openActions(page);
  for (let i = 0; i < 5; i++) {
    const before = await page.locator('.entry').count();
    await cultivate(page).click();
    await expect(page.locator('.entry')).toHaveCount(before + 1);
  }
  expect(await stamina(page)).toBe(0);
  expect(await progress(page)).toBe(55);
  await expect(cultivate(page)).toBeDisabled();
  await expect(page.getByText('体力不足，先休息一下再修炼。')).toBeVisible();
  await rest(page).click();
  await expect(page.locator('.entry')).toHaveCount(7);
  expect(await stamina(page)).toBe(15);
  await expect(cultivate(page)).toBeEnabled();
});

test('刷新页面后状态保持', async ({ page }) => {
  await openActions(page);
  await cultivate(page).click();
  await expect(page.locator('.chip').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.card')).toBeVisible();
  expect(await stamina(page)).toBe(40);
  expect(await progress(page)).toBe(11);
});

test('重启服务后存档保留', async ({ page, server }) => {
  await openActions(page);
  await cultivate(page).click();
  await expect(page.locator('.chip').first()).toBeVisible();
  await server.restart();
  await page.reload();
  await expect(page.locator('.card')).toBeVisible();
  expect(await stamina(page)).toBe(40);
});

test('服务不可用时行动给出可读提示；读档失败可重试', async ({ page, server }) => {
  await openActions(page);
  await page.route('**/api/v1/actions', (r) => r.abort());
  await rest(page).click();
  await expect(page.getByRole('alert')).toContainText('无法连接本地服务');
  await page.unroute('**/api/v1/actions');

  const p2 = await page.context().newPage();
  await p2.route('**/api/v1/player/state', (r) => r.abort());
  await p2.goto(server.url);
  await expect(p2.getByRole('alert')).toContainText('无法连接本地服务');
  await p2.unroute('**/api/v1/player/state');
  await p2.getByRole('button', { name: '重试' }).click();
  await expect(p2.locator('.card')).toBeVisible();
});

for (const [name, width] of [['手机 390', 390], ['小屏 320', 320], ['桌面 1280', 1280]] as const) {
  test(`布局：${name} 无横向滚动，面板不遮挡底部导航`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openActions(page);
    await expect(page.locator('.sheet')).toBeVisible();
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(noHScroll).toBe(true);
    const sheet = await page.locator('.sheet').boundingBox();
    const nav = await page.locator('.nav-wrap').boundingBox();
    expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(nav!.y + 1);
  });
}
