import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const rail = (page: Page, name: string) => page.getByRole('navigation', { name: '功能入口' }).getByRole('button', { name }).click();
const sheet = (page: Page) => page.locator('.sheet');
const entries = (page: Page) => page.locator('.entry');
const where = (page: Page) => page.locator('.loc strong');
const load = async (page: Page, url: string) => {
  await page.goto(url);
  await expect(page.locator('.card')).toBeVisible();
};
/** 打开地图面板；已经开着就不再点（再点会收起） */
const openMap = async (page: Page) => {
  if ((await page.getByRole('dialog', { name: '地图' }).count()) === 0) await nav(page, '地图');
  await expect(page.getByRole('dialog', { name: '地图' })).toBeVisible();
};
const openNpc = async (page: Page, name: string) => {
  await openMap(page);
  await page.getByRole('button', { name: `查看${name}` }).click();
  await expect(sheet(page).getByRole('button', { name: /打招呼|已相识/ })).toBeVisible();
};
const greet = async (page: Page) => {
  await sheet(page).getByRole('button', { name: '打招呼' }).click();
  await expect(sheet(page).getByRole('button', { name: '已相识' })).toBeVisible();
};
const go = async (page: Page, place: string) => {
  await openMap(page);
  await sheet(page).getByRole('button', { name: `前往青云山 · ${place}` }).click();
  await expect(where(page)).toContainText(place);
};

test.describe('系统事件：传闻 → 开始 → 到场参加', () => {
  test('风声出现在日志里；开始后地图里能看到并要到场才能参加；参加后得到奖励且事件从列表消失', async ({ page, server }) => {
    await load(page, server.url);
    await server.advanceGame(1800 - 420); // 第 2 天 06:00，晨课 07:00 开始
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(entries(page).filter({ hasText: '明早练功场有晨课' })).toHaveCount(1);
    await expect(entries(page).filter({ hasText: '明早练功场有晨课' }).locator('.sub')).toHaveText('传闻');

    await openMap(page);
    const live = sheet(page).getByLabel('眼下的事');
    await expect(live).toContainText('风声');
    await expect(live.getByRole('button', { name: /^参加/ })).toHaveCount(0); // 还没开始
    await page.keyboard.press('Escape');

    await server.advanceGame(60); // 07:00 开始
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await openMap(page);
    await expect(live).toContainText('练功场晨课');
    await expect(live.getByRole('button', { name: '参加练功场晨课' })).toBeDisabled();
    await expect(live).toContainText('你不在现场');

    await sheet(page).getByRole('button', { name: '前往青云山 · 练功场' }).click();
    await expect(where(page)).toContainText('练功场');
    await expect(live.getByRole('button', { name: '参加练功场晨课' })).toBeEnabled();
    await live.getByRole('button', { name: '参加练功场晨课' }).click();
    await expect(entries(page).filter({ hasText: '一套入门剑法' })).toHaveCount(1);
    await expect(entries(page).filter({ hasText: '一套入门剑法' }).locator('.chip')).toContainText('经验 +4%');
    await expect(sheet(page).getByLabel('眼下的事')).toHaveCount(0); // 已了结，不再列出
  });

  test('错过窗口：规则自行了结，日志里是新闻；藏经阁被封锁并写明原因', async ({ page, server }) => {
    await load(page, server.url);
    await server.advanceGame(2200 - 420); // 第 2 天 12:40：晨课已过、藏经阁已封
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await expect(entries(page).filter({ hasText: '晨课照常举行' }).locator('.sub')).toHaveText('新闻');
    await expect(entries(page).filter({ hasText: '闭门整修' })).toHaveCount(1);
    await openMap(page);
    await sheet(page).getByRole('button', { name: '前往青云山 · 练功场' }).click();
    await expect(where(page)).toContainText('练功场');
    const row = sheet(page).locator('.w-row', { has: page.getByRole('button', { name: '前往青云山 · 藏经阁' }) });
    await expect(row.getByRole('button')).toBeDisabled();
    await expect(row).toContainText('过不去：整修中，暂不开放');
  });
});

test.describe('地图与移动', () => {
  test('列出相邻地点与在场的人；前往后位置与体力更新，日志有记录，地图随之变化', async ({ page, server }) => {
    await load(page, server.url);
    await nav(page, '地图');
    await expect(sheet(page).getByRole('button', { name: '前往青云山 · 练功场' })).toBeEnabled();
    await expect(sheet(page).getByRole('button', { name: /前往青云山 · (大殿|藏经阁)/ })).toHaveCount(0); // 不相邻不显示
    await expect(sheet(page).getByRole('button', { name: '查看赵铁牛' })).toContainText('守门弟子');
    await sheet(page).getByRole('button', { name: '前往青云山 · 练功场' }).click();
    await expect(where(page)).toContainText('练功场');
    await expect(entries(page).last()).toContainText('前往青云山 · 练功场');
    await expect(entries(page).last().locator('.chip')).toContainText('体力 −3');
    // 地图刷新：现在能去山门、大殿、藏经阁，这里是大师姐
    await expect(sheet(page).getByRole('button', { name: /前往青云山 · (山门|大殿|藏经阁)/ })).toHaveCount(3);
    await expect(sheet(page).getByRole('button', { name: '查看苏晚晴' })).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: '查看赵铁牛' })).toHaveCount(0);
  });

  test('体力不足：所有「前往」置灰并给出原因', async ({ page, server }) => {
    await server.setPlayer({ stamina: 2 });
    await load(page, server.url);
    await nav(page, '地图');
    for (const b of await sheet(page).getByRole('button', { name: /^前往/ }).all()) await expect(b).toBeDisabled();
    await expect(sheet(page)).toContainText('体力不足，先休息一下再赶路');
  });

  test('山下：山门可去山道，山道通小镇；每条路的体力与耗时由服务端给出', async ({ page, server }) => {
    await load(page, server.url);
    await nav(page, '地图');
    const row = (name: string) => sheet(page).locator('.w-row', { has: page.getByRole('button', { name: `前往${name}` }) });
    await expect(row('青云山 · 练功场')).toContainText('约 30 分钟');
    await expect(row('山下 · 山道')).toContainText('体力 −3');
    await expect(row('山下 · 山道')).toContainText('约 60 分钟');
    await expect(row('山下 · 山道')).toContainText('没去过');
    await sheet(page).getByRole('button', { name: '前往山下 · 山道' }).click();
    await expect(where(page)).toContainText('山道');
    await expect(sheet(page).getByRole('button', { name: '前往山下 · 小镇' })).toBeEnabled();
    await sheet(page).getByRole('button', { name: '前往山下 · 小镇' }).click();
    await expect(where(page)).toContainText('小镇');
    // 回头：山道已经去过，不再标「没去过」
    await expect(sheet(page).locator('.w-row', { has: page.getByRole('button', { name: '前往山下 · 山道' }) })).not.toContainText('没去过');
  });

  test('地点被封锁：「前往」置灰并显示原因；解除后恢复', async ({ page, server }) => {
    await server.setLocation('loc_foot_path', 'blocked', '山道塌方');
    await load(page, server.url);
    await nav(page, '地图');
    const row = sheet(page).locator('.w-row', { has: page.getByRole('button', { name: '前往山下 · 山道' }) });
    await expect(row.getByRole('button')).toBeDisabled();
    await expect(row).toContainText('过不去：山道塌方');
    await expect(sheet(page).getByRole('button', { name: '前往青云山 · 练功场' })).toBeEnabled(); // 其他路不受影响
    await server.setLocation('loc_foot_path', 'open');
    await load(page, server.url);
    await nav(page, '地图');
    await expect(sheet(page).getByRole('button', { name: '前往山下 · 山道' })).toBeEnabled();
  });

  test('用自由输入说「去练功场」；说「去大殿」被服务端拒绝并说明原因', async ({ page, server }) => {
    await load(page, server.url);
    await nav(page, '行动');
    await page.getByLabel('自由行动输入').fill('去大殿');
    await page.locator('form.free').getByRole('button').click();
    await expect(page.locator('.reply.warn')).toContainText('不在附近');
    await expect(where(page)).toContainText('山门');
    await page.getByLabel('自由行动输入').fill('去练功场');
    await page.locator('form.free').getByRole('button').click();
    await expect(where(page)).toContainText('练功场');
    await expect(page.locator('.reply')).toContainText('前往青云山 · 练功场');
  });
});

test.describe('人物', () => {
  test('人物卡：身份、态度、记忆；打招呼后留下记忆并调整态度；再次不可用；刷新后仍已相识', async ({ page, server }) => {
    await load(page, server.url);
    await openNpc(page, '赵铁牛');
    await expect(sheet(page)).toContainText('守门弟子');
    await expect(sheet(page).getByRole('meter', { name: '好感' })).toHaveAttribute('aria-valuenow', '10');
    await expect(sheet(page)).toContainText('还没有');
    await greet(page);
    await expect(sheet(page).getByRole('meter', { name: '好感' })).toHaveAttribute('aria-valuenow', '13');
    await expect(sheet(page).getByRole('meter', { name: '信任' })).toHaveAttribute('aria-valuenow', '22');
    await expect(sheet(page)).toContainText('你与赵铁牛初次相识。');
    await expect(entries(page).last()).toContainText('拱手见礼');
    await sheet(page).getByText('关系是怎么来的').click();
    await expect(sheet(page)).toContainText('初次相识');
    await expect(sheet(page)).toContainText('好感 +3 · 信任 +2');
    await expect(sheet(page)).toContainText('已核对 ✓');

    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await openNpc(page, '赵铁牛');
    await expect(sheet(page).getByRole('button', { name: '已相识' })).toBeDisabled();
    await expect(sheet(page)).toContainText('你与赵铁牛初次相识。');
  });
});

test.describe('任务：完整的新手任务链（全程不依赖 AI）', () => {
  test.use({ aiOff: true });
  test('接取 → 认人 → 前往 → 认人 → 领取奖励；进度提示立即出现在日志里；红点随状态变化', async ({ page, server }) => {
    await load(page, server.url);
    await expect(page.getByTestId('quest-badge')).toBeVisible(); // 有可接取的任务
    await rail(page, '任务');
    await expect(sheet(page).getByRole('article', { name: '证明自己' })).toContainText('需要先完成「初入山门」');
    await sheet(page).getByRole('article', { name: '初入山门' }).getByRole('button', { name: '接取' }).click();
    await expect(sheet(page).getByRole('article', { name: '初入山门' })).toContainText('进行中');
    await expect(entries(page).last()).toContainText('你接下了任务「初入山门」');

    await openNpc(page, '赵铁牛');
    await greet(page);
    await expect(entries(page).filter({ hasText: '与守门弟子赵铁牛相识 ✓' })).toHaveCount(1); // 不用刷新

    await go(page, '练功场');
    await expect(entries(page).filter({ hasText: '前往练功场 ✓' })).toHaveCount(1);
    await openNpc(page, '苏晚晴');
    await greet(page);
    await expect(entries(page).filter({ hasText: '可以领取奖励' })).toHaveCount(1);
    await expect(entries(page).filter({ hasText: '新任务「证明自己」可以接取了' })).toHaveCount(1);

    await rail(page, '任务');
    const card = sheet(page).getByRole('article', { name: '初入山门' });
    await expect(card).toContainText('已完成');
    await expect(card.locator('.w-steps li.done')).toHaveCount(3);
    await card.getByRole('button', { name: '领取奖励' }).click();
    await expect(card).toContainText('已领取');
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(entries(page).last().locator('.chip')).toContainText('铜钱 +100');
    await expect(entries(page).last()).toContainText('赵铁牛笑着拍了拍你的肩');
    await expect(sheet(page).getByRole('article', { name: '证明自己' })).toContainText('可接取');
    await expect(page.getByTestId('quest-badge')).toBeVisible(); // 新任务可接取

    // 刷新后全部状态都在
    await page.reload();
    await expect(page.locator('.card')).toBeVisible();
    await rail(page, '任务');
    await expect(sheet(page).getByRole('article', { name: '初入山门' })).toContainText('已领取');
    await expect(entries(page).filter({ hasText: '可以领取奖励' })).toHaveCount(1);
    // 苏晚晴对你的态度：相识 +3/+2
    await openNpc(page, '苏晚晴');
    await expect(sheet(page).getByRole('meter', { name: '好感' })).toHaveAttribute('aria-valuenow', '23');
  });

  test('放弃进行中的任务：变为已失败，不再有按钮，后续任务保持锁定', async ({ page, server }) => {
    await load(page, server.url);
    await rail(page, '任务');
    const card = sheet(page).getByRole('article', { name: '初入山门' });
    await card.getByRole('button', { name: '接取' }).click();
    await card.getByRole('button', { name: '放弃' }).click();
    await expect(card).toContainText('已失败');
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(sheet(page).getByRole('article', { name: '证明自己' })).toContainText('未解锁');
  });

  test('AI 关闭时地图、打招呼、任务都可用，只有自由输入置灰', async ({ page, server }) => {
    await load(page, server.url);
    await nav(page, '行动');
    await expect(page.getByLabel('自由行动输入')).toBeDisabled();
    await go(page, '练功场');
    await openNpc(page, '苏晚晴');
    await greet(page);
  });
});

test.describe('任务：第二个任务的进度与突破', () => {
  test('修炼进度与突破条件在任务卡上逐步完成，奖励发放丹药', async ({ page, server }) => {
    await server.setRng(0);
    await load(page, server.url);
    // 先走完第一个任务
    await rail(page, '任务');
    await sheet(page).getByRole('article', { name: '初入山门' }).getByRole('button', { name: '接取' }).click();
    await openNpc(page, '赵铁牛');
    await greet(page);
    await go(page, '练功场');
    await openNpc(page, '苏晚晴');
    await greet(page);
    await rail(page, '任务');
    await sheet(page).getByRole('article', { name: '初入山门' }).getByRole('button', { name: '领取奖励' }).click();
    const card = sheet(page).getByRole('article', { name: '证明自己' });
    await card.getByRole('button', { name: '接取' }).click();
    await server.setPlayer({ realmProgress: 100 });
    await nav(page, '行动');
    await page.locator('.act:not(.bt)', { hasText: '休息' }).click(); // 触发评估
    await rail(page, '任务');
    await expect(card.locator('.w-steps li.done')).toHaveCount(1);
    await expect(card.locator('.w-steps li.now')).toContainText('突破到通窍境界');
    await nav(page, '行动');
    await page.locator('.act.bt').click();
    await page.getByRole('dialog').getByRole('button', { name: '确认突破' }).click();
    await expect(page.locator('.realm')).toHaveText('通窍');
    await rail(page, '任务');
    await expect(card).toContainText('已完成');
    await card.getByRole('button', { name: '领取奖励' }).click();
    await expect(card).toContainText('已领取');
    await expect(entries(page).last()).toContainText('凡阶突破丹 ×1');
    await nav(page, '背包');
    await expect(sheet(page)).toContainText('凡阶突破丹');
    await expect(sheet(page).locator('.qty')).toContainText('2');
  });
});

for (const [name, width] of [['手机 390', 390], ['小屏 320', 320], ['桌面 1280', 1280]] as const) {
  test(`布局：${name} 地图、人物卡、任务面板无横向滚动，不遮挡底部导航`, async ({ page, server }) => {
    await page.setViewportSize({ width, height: 800 });
    await load(page, server.url);
    const check = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const s = await sheet(page).boundingBox();
      const n = await page.locator('.nav-wrap').boundingBox();
      expect(s!.y + s!.height).toBeLessThanOrEqual(n!.y + 1);
      expect(s!.y).toBeGreaterThanOrEqual(0);
    };
    await nav(page, '地图');
    await check();
    await page.getByRole('button', { name: '查看赵铁牛' }).click();
    await expect(sheet(page).getByRole('button', { name: '打招呼' })).toBeVisible();
    await sheet(page).getByText('关系是怎么来的').click();
    await check();
    await rail(page, '任务');
    await check();
  });
}
