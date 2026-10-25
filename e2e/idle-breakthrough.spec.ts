import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;

const bar = (page: Page, name: string) => page.getByRole('progressbar', { name });
const num = async (page: Page, name: string) => Number(await bar(page, name).getAttribute('aria-valuenow'));
const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const btEntry = (page: Page) => page.locator('.act.bt');
const dlg = (page: Page) => page.getByRole('dialog', { name: /突破/ });
const openModal = async (page: Page) => {
  await openActions(page);
  await btEntry(page).click();
  await expect(dlg(page)).toBeVisible();
};
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};

test.describe('背包', () => {
  test('列出初始赠送的凡阶突破丹', async ({ page, server }) => {
    await load(page, server.url);
    await page.getByRole('button', { name: '背包', exact: true }).click();
    await expect(page.locator('.inv li')).toHaveCount(1);
    await expect(page.locator('.inv li')).toContainText('凡阶突破丹');
    await expect(page.locator('.inv li')).toContainText('×1');
  });
});

test.describe('放置修炼', () => {
  test('开始 → 领取收益；重复领取不会重复发放', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.getByRole('button', { name: '开始放置修炼' }).click();
    await expect(page.getByText('修炼中')).toBeVisible();
    await expect(page.getByText('暂无可领取的收益')).toHaveCount(0); // 刚开始时不应出现该提示

    await server.advance(10 * MIN);
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.locator('.chip', { hasText: '经验 +2%' })).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '放置修炼 · 结算 10 分钟' })).toBeVisible();
    expect(await num(page, '晋级进度')).toBe(2);

    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.getByText('暂无可领取的收益')).toBeVisible();
    expect(await num(page, '晋级进度')).toBe(2);
    await expect(page.locator('.chip', { hasText: '经验 +' })).toHaveCount(1);
  });

  test('打开页面时自动结算离开期间的收益', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.getByRole('button', { name: '开始放置修炼' }).click();
    await expect(page.getByText('修炼中')).toBeVisible();

    await server.advance(20 * MIN); // 模拟关闭页面期间过去 20 分钟
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect.poll(() => num(page, '晋级进度')).toBe(4);
  });

  test('停止：先结算再停止，之后可以重新开始', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await page.getByRole('button', { name: '开始放置修炼' }).click();
    await server.advance(10 * MIN);
    await page.getByRole('button', { name: '停止' }).click();
    await expect(page.getByText('未在修炼')).toBeVisible();
    await expect(page.getByText('暂无可领取的收益')).toHaveCount(0);
    expect(await num(page, '晋级进度')).toBe(2);
    await expect(page.getByRole('button', { name: '开始放置修炼' })).toBeEnabled();
  });

  test('进度已满时不能开始，并提示先突破', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await load(page, server.url);
    await openActions(page);
    await expect(page.getByRole('button', { name: '开始放置修炼' })).toBeDisabled();
    await expect(page.getByText('修炼已圆满，请先尝试突破')).toBeVisible();
  });

  test('圆满后自动停止并提示', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 99 });
    await load(page, server.url);
    await openActions(page);
    await page.getByRole('button', { name: '开始放置修炼' }).click();
    await server.advance(24 * HOUR);
    await page.getByRole('button', { name: '领取收益' }).click();
    await expect(page.locator('.entry .sub', { hasText: '修炼已圆满' })).toBeVisible();
    expect(await num(page, '晋级进度')).toBe(100);
    await expect(page.getByText('未在修炼')).toBeVisible();
  });
});

test.describe('突破', () => {
  test('进度未满：入口禁用并显示进度', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await expect(btEntry(page)).toBeDisabled();
    await expect(btEntry(page)).toContainText('进度 0/100');
  });

  test('成功：成功率明细、选用丹药、晋级、丹药消耗、日志留痕', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0);
    await load(page, server.url);
    await openActions(page);
    await expect(btEntry(page)).toContainText('可突破 · 成功率约 70%');
    await btEntry(page).click();

    const dialog = dlg(page);
    await expect(dialog).toContainText('炼体 → 通窍');
    await expect(dialog.locator('.total b')).toHaveText('70%');
    await dialog.getByLabel(/凡阶突破丹/).check();
    await expect(dialog.locator('.total b')).toHaveText('80%');
    await expect(dialog).toContainText('丹药加成');
    await dialog.getByRole('button', { name: '确认突破' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.locator('.realm')).toHaveText('通窍');
    expect(await num(page, '晋级进度')).toBe(0);
    await expect(page.locator('.chip', { hasText: '境界 炼体→通窍' })).toBeVisible();
    await expect(page.locator('.chip', { hasText: '气血上限 +30' })).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '成功率 80% · 掷点 0.00 · 消耗凡阶突破丹 ×1' })).toBeVisible();

    await page.getByRole('button', { name: '收起' }).click();
    await page.getByRole('button', { name: '背包', exact: true }).click();
    await expect(page.getByText('背包里还没有物品')).toBeVisible();
  });

  test('失败：进度回落、气血受损、进入冷却（含倒计时），冷却后可再次突破；丹药未使用则保留', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0.9999);
    await load(page, server.url);
    await openModal(page);
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(dlg(page)).toHaveCount(0);

    await expect(page.locator('.realm')).toHaveText('炼体');
    expect(await num(page, '晋级进度')).toBe(80);
    expect(await num(page, '气血')).toBe(80);
    await expect(page.locator('.chip', { hasText: '经验 −20%' })).toBeVisible();
    await expect(page.locator('.entry .sub', { hasText: '冷却 24 游戏小时' })).toBeVisible();
    await expect(btEntry(page)).toBeDisabled();
    await expect(btEntry(page)).toContainText('冷却剩余 1 天'); // 24 游戏小时

    // 重新修炼满并等过冷却
    await server.setPlayer({ realmProgress: 100 });
    await server.advance(24 * HOUR); // 现实时间过去再久，游戏时间不动，冷却仍在
    await page.reload();
    await openActions(page);
    await expect(btEntry(page)).toBeDisabled();
    await server.advanceGame(24 * 60); // 游戏里过了 24 小时
    await page.reload();
    await openActions(page);
    await expect(btEntry(page)).toBeEnabled();
    await expect(btEntry(page)).toContainText('可突破');

    await page.getByRole('button', { name: '收起' }).click();
    await page.getByRole('button', { name: '背包', exact: true }).click();
    await expect(page.locator('.inv li')).toContainText('×1'); // 失败那次没带丹药，丹药还在
  });

  test('带丹药失败也会消耗丹药', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0.9999);
    await load(page, server.url);
    await openModal(page);
    await page.getByLabel(/凡阶突破丹/).check();
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(page.locator('.entry .sub', { hasText: '消耗凡阶突破丹 ×1' })).toBeVisible();
    await page.getByRole('button', { name: '收起' }).click();
    await page.getByRole('button', { name: '背包', exact: true }).click();
    await expect(page.getByText('背包里还没有物品')).toBeVisible();
  });

  test('Esc 与点击遮罩可以取消，不产生任何行动', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await load(page, server.url);
    let posts = 0;
    page.on('request', (r) => r.method() === 'POST' && r.url().includes('/api/v1/actions') && posts++);
    await openModal(page);
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
    await btEntry(page).click();
    await page.locator('.modal').click({ position: { x: 3, y: 3 } });
    await expect(dlg(page)).toHaveCount(0);
    expect(posts).toBe(0);
    expect(await num(page, '晋级进度')).toBe(100);
  });

  test('服务端拒绝时弹窗保持打开并显示原因', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await load(page, server.url);
    await page.route('**/api/v1/actions', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PRECONDITION_FAILED', message: '上次突破失败，气息未平，需隔一日再试', request_id: 'x' }),
      }),
    );
    await openModal(page);
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(dlg(page).getByRole('alert')).toContainText('需隔一日再试');
    await expect(dlg(page)).toBeVisible();
  });

  test('网络中断后重试复用同一个幂等键（不会重复扣丹药）', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0);
    await load(page, server.url);
    const keys: string[] = [];
    let first = true;
    await page.route('**/api/v1/actions', async (route) => {
      keys.push(JSON.parse(route.request().postData() ?? '{}').idempotencyKey);
      if (first) {
        first = false;
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });
    await openModal(page);
    await page.getByLabel(/凡阶突破丹/).check();
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(dlg(page).getByRole('alert')).toContainText('无法连接本地服务');
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(dlg(page)).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(page.locator('.realm')).toHaveText('通窍');
  });

  test('重启服务后冷却仍然生效', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0.9999);
    await load(page, server.url);
    await openModal(page);
    await page.getByRole('button', { name: '确认突破' }).click();
    await expect(page.locator('.chip', { hasText: '经验 −20%' })).toBeVisible();
    await server.restart();
    await server.setPlayer({ realmProgress: 100 });
    await page.reload();
    await openActions(page);
    await expect(btEntry(page)).toBeDisabled();
    await expect(btEntry(page)).toContainText('气息未平');
  });
});

for (const [name, width] of [['手机 390', 390], ['小屏 320', 320]] as const) {
  test(`布局：${name} 突破弹窗完整可见、无横向滚动`, async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await page.setViewportSize({ width, height: 700 });
    await load(page, server.url);
    await openModal(page);
    const card = await page.locator('.modal-card').boundingBox();
    const col = await page.locator('.col').boundingBox();
    expect(card!.x).toBeGreaterThanOrEqual(col!.x);
    expect(card!.x + card!.width).toBeLessThanOrEqual(col!.x + col!.width + 1);
    expect(card!.y).toBeGreaterThanOrEqual(col!.y);
    expect(card!.y + card!.height).toBeLessThanOrEqual(col!.y + col!.height + 1);
    await expect(page.getByRole('button', { name: '确认突破' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
