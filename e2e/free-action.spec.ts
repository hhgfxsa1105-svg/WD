import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const entries = (page: Page) => page.locator('.entry');
const input = (page: Page) => page.getByLabel('自由行动输入');
const send = (page: Page) => page.locator('form.free').getByRole('button');
const dot = (page: Page) => page.locator('.ai-dot');
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};
const say = async (page: Page, text: string) => {
  await input(page).fill(text);
  await send(page).click();
};
const NARRATE = '山风掠过衣袖';

test.describe('自由行动（AI 正常）', () => {
  test.beforeEach(async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
  });

  test('打坐 → AI 理解为修炼，已执行；日志新增一条，输入框清空，状态点为「AI 正常」', async ({ page }) => {
    await expect(dot(page)).toHaveText('AI 正常');
    await expect(send(page)).toBeDisabled(); // 没有内容时不能发送
    await say(page, '我想打坐一会儿');
    await expect(page.locator('.reply')).toContainText('AI 理解为');
    await expect(page.locator('.reply')).toContainText('修炼（已执行）');
    await expect(entries(page)).toHaveCount(2);
    await expect(page.locator('.chip', { hasText: '体力 −10' })).toBeVisible();
    await expect(input(page)).toHaveValue('');
  });

  test('快捷短句只填入输入框，不会直接发送', async ({ page }) => {
    await page.getByRole('button', { name: '打坐一会儿', exact: true }).click();
    await expect(input(page)).toHaveValue('打坐一会儿');
    await expect(entries(page)).toHaveCount(1);
  });

  test('看不懂时只澄清：写明没有执行任何行动，日志不变，输入内容保留', async ({ page }) => {
    await say(page, '今天天气真好');
    await expect(page.locator('.reply.ask')).toContainText('没有执行任何行动');
    await expect(entries(page)).toHaveCount(1);
    await expect(input(page)).toHaveValue('今天天气真好');
  });

  test('处理期间输入框与发送键锁定，只发出一个请求', async ({ page }) => {
    let posts = 0;
    await page.route('**/api/v1/actions', async (route) => {
      posts++;
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await input(page).fill('打坐');
    await send(page).dblclick();
    await expect(send(page)).toHaveText('处理中');
    await expect(input(page)).toBeDisabled();
    await expect(page.locator('.reply')).toContainText('AI 理解为');
    expect(posts).toBe(1);
  });

  test('网络中断后重发复用同一个幂等键，只结算一次', async ({ page }) => {
    const keys: string[] = [];
    let fail = true;
    await page.route('**/api/v1/actions', async (route) => {
      keys.push(JSON.parse(route.request().postData() ?? '{}').idempotencyKey);
      if (fail) {
        fail = false;
        return route.abort();
      }
      return route.continue();
    });
    await input(page).fill('打坐');
    await send(page).click();
    await expect(page.locator('.reply.warn')).toContainText('无法连接');
    await expect(input(page)).toHaveValue('打坐'); // 内容保留
    await send(page).click();
    await expect(entries(page)).toHaveCount(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('自由突破：叙事由 AI 补写，没有「待补」标记；丹药只消耗一枚', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0);
    await page.reload();
    await openActions(page);
    await page.getByRole('button', { name: '服丹冲击下一境界', exact: true }).click();
    await send(page).click();
    await expect(page.locator('.realm')).toHaveText('通窍');
    await expect(page.locator('.entry p', { hasText: NARRATE })).toBeVisible();
    await expect(page.locator('.pending')).toHaveCount(0);
    await page.getByRole('button', { name: '收起' }).click();
    await page.getByRole('button', { name: '背包', exact: true }).click();
    await expect(page.getByText('背包里还没有物品')).toBeVisible();
  });
});

test.describe('叙事待补与重试', () => {
  test('叙事失败：结果已生效并显示「叙事待补」，刷新后仍在；重试成功后文字被替换且标记消失', async ({ page, server }) => {
    await server.setPlayer({ realmProgress: 100 });
    await server.setRng(0);
    await server.setAi({ narrate: 'fail' });
    await load(page, server.url);
    await openActions(page);
    await say(page, '突破');
    await expect(page.locator('.realm')).toHaveText('通窍');
    await expect(page.locator('.pending .tag')).toHaveText('叙事待补');
    await expect(page.locator('.entry p', { hasText: NARRATE })).toHaveCount(0);
    await expect(page.locator('.chip', { hasText: '境界 炼体→通窍' })).toBeVisible();

    await page.reload();
    await expect(page.locator('.pending .tag')).toHaveText('叙事待补');

    // 重试仍失败：提示原因，标记保留
    await page.getByRole('button', { name: '重新叙事' }).click();
    await expect(page.locator('.pending .fail')).toContainText('AI 暂时无法响应');
    await expect(page.locator('.pending .tag')).toBeVisible();

    // 恢复后重试成功
    await server.setAi({ narrate: 'ok' });
    await page.getByRole('button', { name: '重新叙事' }).click();
    await expect(page.locator('.entry p', { hasText: NARRATE })).toBeVisible();
    await expect(page.locator('.pending')).toHaveCount(0);
    await expect(page.locator('.realm')).toHaveText('通窍'); // 重试没有改变任何结算结果
    await expect(page.locator('.chip', { hasText: '境界 炼体→通窍' })).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.entry p', { hasText: NARRATE })).toBeVisible();
    await expect(page.locator('.pending')).toHaveCount(0);
  });
});

test.describe('AI 不可用时的降级', () => {
  test('解析故障：显示友好提示和「AI 暂不可用」，输入保留，固定行动照常；恢复后可重发', async ({ page, server }) => {
    await server.setAi({ parse: 'fail' });
    await load(page, server.url);
    await openActions(page);
    await say(page, '我想打坐');
    await expect(page.locator('.reply.warn')).toContainText('AI 暂时无法响应');
    await expect(page.locator('.reply.warn')).not.toContainText(/500|SERVER_ERROR|e2e/);
    await expect(dot(page)).toHaveText('AI 暂不可用');
    await expect(input(page)).toHaveValue('我想打坐');
    await expect(entries(page)).toHaveCount(1);

    await page.locator('.act:not(.bt)', { hasText: '修炼' }).click(); // 固定行动不受影响
    await expect(entries(page)).toHaveCount(2);

    await server.setAi({ parse: 'ok' });
    await send(page).click();
    await expect(entries(page)).toHaveCount(3);
    await expect(dot(page)).toHaveText('AI 正常');
  });

  test('当日次数用完：状态点提示，输入框禁用并说明原因，固定行动可用', async ({ page, server }) => {
    await server.setAi({ dailyLimit: 0 });
    await load(page, server.url);
    await openActions(page);
    await expect(dot(page)).toHaveText('AI 次数用完');
    await expect(input(page)).toBeDisabled();
    await expect(page.locator('.reply.warn')).toContainText('今天的 AI 次数用完了');
    await page.locator('.act:not(.bt)', { hasText: '修炼' }).click();
    await expect(entries(page)).toHaveCount(2);
  });
});

test.describe('AI 未开启', () => {
  test.use({ aiOff: true });
  test('状态点为「AI 未开启」，输入框禁用并说明，固定行动与突破入口照常', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await expect(dot(page)).toHaveText('AI 未开启');
    await expect(input(page)).toBeDisabled();
    await expect(page.locator('.reply.warn')).toContainText('AI 功能未开启');
    await expect(page.getByRole('button', { name: '打坐一会儿', exact: true })).toHaveCount(0);
    await page.locator('.act:not(.bt)', { hasText: '修炼' }).click();
    await expect(entries(page)).toHaveCount(2);
  });
});

for (const [name, width] of [['手机 390', 390], ['小屏 320', 320], ['桌面 1280', 1280]] as const) {
  test(`布局：${name} 自由行动面板无横向滚动，不遮挡底部导航`, async ({ page, server }) => {
    await page.setViewportSize({ width, height: 800 });
    await load(page, server.url);
    await openActions(page);
    await say(page, '今天天气真好');
    await expect(page.locator('.reply.ask')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator('.sheet').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); // 面板内部也不能横向溢出
    const sheet = await page.locator('.sheet').boundingBox();
    const nav = await page.locator('.nav-wrap').boundingBox();
    expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(nav!.y + 1);
    expect(sheet!.y).toBeGreaterThanOrEqual(0);
  });
}
