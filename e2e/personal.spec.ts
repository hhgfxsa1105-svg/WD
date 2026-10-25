import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
const entries = (page: Page) => page.locator('.entry');
const input = (page: Page) => page.getByLabel('自由行动输入');
const send = (page: Page) => page.locator('form.free').getByRole('button');
const card = (page: Page) => page.getByLabel('正在进行的事');
const stamina = async (page: Page) => Number(await page.getByRole('progressbar', { name: '体力' }).getAttribute('aria-valuenow'));
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};
const say = async (page: Page, text: string) => {
  await input(page).fill(text);
  await send(page).click();
};

test.describe('自定义行为 → 个人事件', () => {
  test('说一件预设之外的事：AI 提议个人事件，面板出现事件卡；进行后成功，日志有结果与传闻，体力扣减', async ({ page, server }) => {
    await server.setRng(0); // 必成功
    await load(page, server.url);
    await openActions(page);
    const s0 = await stamina(page);
    await say(page, '我想向人打听消息');
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('向赵铁牛打听消息');
    await expect(card(page)).toContainText('约 30 分钟');
    await expect(card(page)).toContainText('成功率约');
    await expect(entries(page).filter({ hasText: '向赵铁牛打听消息' }).locator('.sub')).toHaveText('个人事件');
    expect(await stamina(page)).toBe(s0); // 提议本身不耗体力

    await card(page).getByRole('button', { name: /^进行/ }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(entries(page).filter({ hasText: '把近来听到的风声说了不少' })).toHaveCount(1);
    await expect(entries(page).filter({ hasText: '山下最近不太平' }).locator('.sub')).toHaveText('传闻');
    await expect.poll(() => stamina(page)).toBe(s0 - 5);
  });

  test('进行失败：掷点不过，日志是失败那一支的叙述', async ({ page, server }) => {
    await server.setRng(0.9999);
    await load(page, server.url);
    await openActions(page);
    await say(page, '我想向人打听消息');
    await card(page).getByRole('button', { name: /^进行/ }).click();
    await expect(entries(page).filter({ hasText: '警觉地看了你一眼' })).toHaveCount(1);
    await expect(card(page)).toHaveCount(0);
  });

  test('放弃：算失败，不耗体力，事件卡消失，之后能再开新的', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    const s0 = await stamina(page);
    await say(page, '我想向人打听消息');
    await card(page).getByRole('button', { name: /^放弃/ }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(entries(page).filter({ hasText: '你放弃了' })).toHaveCount(1);
    expect(await stamina(page)).toBe(s0);
    await say(page, '我想向人打听消息');
    await expect(card(page)).toBeVisible();
  });

  test('正忙：事件进行中再开新的被拒绝并说明原因；不影响固定行动', async ({ page, server }) => {
    await load(page, server.url);
    await openActions(page);
    await say(page, '我想向人打听消息');
    await expect(card(page)).toBeVisible();
    await say(page, '我想再去打探点什么');
    await expect(page.locator('.err, .reply.warn').first()).toContainText('正忙着');
    await expect(page.locator('.act:not(.bt)', { hasText: '休息' })).toBeEnabled();
  });

  test('正忙期间，地图上的系统事件看得到但参加不了，并说明原因', async ({ page, server }) => {
    await load(page, server.url);
    await server.advanceGame(1830 - 420); // 第 2 天 06:30，晨课 07:00 开始
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await openActions(page);
    await say(page, '我想向人打听消息');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await server.advanceGame(30); // 07:00，晨课开始；个人事件还没逾期
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await page.getByRole('button', { name: '地图', exact: true }).click();
    const live = page.locator('.sheet').getByLabel('眼下的事');
    await expect(live.getByRole('button', { name: '参加练功场晨课' })).toBeDisabled();
    await expect(live).toContainText('你正忙着');
  });
});
