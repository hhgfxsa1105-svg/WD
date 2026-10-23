# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: offline.spec.ts >> 系统时间异常 >> 系统时间被调到过去：游戏时间暂停，不产生额外收益，并给出提示
- Location: e2e/offline.spec.ts:67:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('alert').filter({ hasText: '系统时间早于游戏时间' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('alert').filter({ hasText: '系统时间早于游戏时间' }) with timeout 5000ms
  - waiting for getByRole('alert').filter({ hasText: '系统时间早于游戏时间' })

```

```yaml
- navigation "功能入口":
  - button "设置"
  - button "任务"
  - button "消息"
- main:
  - region "角色":
    - button "林惊鸿"
    - text: 头衔山门弟子
    - emphasis: 凡
    - text: 元宝 0 银两 10 铜钱 320 炼体
    - progressbar "晋级进度"
    - term: 神
    - definition: "5"
    - term: 力
    - definition: "5"
    - term: 敏
    - definition: "5"
    - term: 根
    - definition: "5"
    - term: 悟
    - definition: "5"
    - term: 福
    - definition: "5"
    - text: 气血
    - progressbar "气血"
    - text: 100/100 体力
    - progressbar "体力"
    - text: 50/50
  - text: 位置
  - strong: 青云山 · 山门
  - text: 晴 · 辰时
  - region "日志":
    - text: 日志 1 条
    - list:
      - listitem:
        - time: 辰时
        - paragraph: 你醒来时，天光尚淡。远处山门钟声一响，今日的江湖便开始了。
  - group "主导航":
    - button "背包"
    - button "功法"
    - button "地图"
    - button "行动" [pressed]
  - dialog "行动":
    - heading "行动" [level=3]
    - button "收起"
    - region "放置修炼":
      - heading "放置修炼" [level=4]
      - text: 修炼中 已累计 0 分钟 · 可领取约 +0% 经验
      - button "领取收益"
      - button "停止"
    - paragraph: 离线最多计入 12 小时，按 50% 效率
    - region "固定行动":
      - heading "固定行动" [level=4]
      - button "修炼 体力 −10 · 获得经验":
        - strong: 修炼
        - text: 体力 −10 · 获得经验
      - button "休息 体力 +15 · 气血 +5":
        - strong: 休息
        - text: 体力 +15 · 气血 +5
    - region "突破":
      - heading "突破" [level=4]
      - button "突破 · 炼体 → 通窍 进度 2/100，修炼圆满后可突破" [disabled]:
        - strong: 突破 · 炼体 → 通窍
        - text: 进度 2/100，修炼圆满后可突破
    - textbox "自由行动输入" [disabled]:
      - /placeholder: 自由行动将在 AI 接入后开放（S3）
    - button "行动" [disabled]
```

# Test source

```ts
  1   | import type { Page } from '@playwright/test';
  2   | import { expect, test } from './fixtures';
  3   | 
  4   | const MIN = 60_000;
  5   | const HOUR = 60 * MIN;
  6   | 
  7   | const progress = async (page: Page) => Number(await page.getByRole('progressbar', { name: '晋级进度' }).getAttribute('aria-valuenow'));
  8   | const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
  9   | const load = async (page: Page, url: string) => {
  10  |   await page.goto(url);
  11  |   await expect(page.locator('.card')).toBeVisible();
  12  | };
  13  | const startIdle = async (page: Page) => {
  14  |   await openActions(page);
  15  |   await page.getByRole('button', { name: '开始放置修炼' }).click();
  16  |   await expect(page.getByText('修炼中')).toBeVisible();
  17  | };
  18  | 
  19  | test.describe('离线收益（真实离线策略）', () => {
  20  |   test.use({ realOffline: true });
  21  | 
  22  |   test('离线 2 小时：重新打开页面自动结算，按 50% 效率，日志有离线汇总', async ({ page, server }) => {
  23  |     await load(page, server.url);
  24  |     await startIdle(page);
  25  |     await server.advance(2 * HOUR);
  26  |     await page.reload();
  27  |     await expect(page.locator('.card')).toBeVisible();
  28  |     await expect.poll(() => progress(page)).toBe(12);
  29  |     await expect(page.locator('.entry .sub', { hasText: '离线 2 小时，计入 2 小时（效率 50%）' })).toBeVisible();
  30  |   });
  31  | 
  32  |   test('离线超过 12 小时：只计入上限，日志注明已达上限；再次领取没有额外收益', async ({ page, server }) => {
  33  |     await load(page, server.url);
  34  |     await startIdle(page);
  35  |     await server.advance(48 * HOUR);
  36  |     await page.reload();
  37  |     await expect(page.locator('.card')).toBeVisible();
  38  |     await expect.poll(() => progress(page)).toBe(75);
  39  |     await expect(page.locator('.entry .sub', { hasText: '离线 48 小时，已达上限，仅计入 12 小时（效率 50%）' })).toBeVisible();
  40  | 
  41  |     await openActions(page);
  42  |     await page.getByRole('button', { name: '领取收益' }).click();
  43  |     await expect(page.getByText('暂无可领取的收益')).toBeVisible();
  44  |     expect(await progress(page)).toBe(75);
  45  |   });
  46  | 
  47  |   test('放置修炼区显示离线规则', async ({ page, server }) => {
  48  |     await load(page, server.url);
  49  |     await openActions(page);
  50  |     await expect(page.getByLabel('离线规则')).toHaveText('离线最多计入 12 小时，按 50% 效率');
  51  |   });
  52  | 
  53  |   test('在线（每次接触都会刷新）：分两段各 3 分钟领取，全额且不带离线说明', async ({ page, server }) => {
  54  |     await load(page, server.url);
  55  |     await startIdle(page);
  56  |     await server.advance(3 * MIN);
  57  |     await page.getByRole('button', { name: '领取收益' }).click(); // 3 × 0.21 = 0.63，暂无收益，但刷新了接触时间
  58  |     await expect(page.getByText('暂无可领取的收益')).toBeVisible();
  59  |     await server.advance(3 * MIN);
  60  |     await page.getByRole('button', { name: '领取收益' }).click(); // 累计 6 分钟，距上次接触仅 3 分钟：在线全额，6 × 0.21 = 1.26 → +1
  61  |     await expect(page.locator('.chip', { hasText: '经验 +1%' })).toBeVisible();
  62  |     await expect(page.locator('.entry .sub', { hasText: '离线' })).toHaveCount(0);
  63  |   });
  64  | });
  65  | 
  66  | test.describe('系统时间异常', () => {
  67  |   test('系统时间被调到过去：游戏时间暂停，不产生额外收益，并给出提示', async ({ page, server }) => {
  68  |     await load(page, server.url);
  69  |     await startIdle(page);
  70  |     await server.advance(10 * MIN);
  71  |     await page.getByRole('button', { name: '领取收益' }).click();
  72  |     await expect.poll(() => progress(page)).toBe(2);
  73  | 
  74  |     await server.advance(-24 * HOUR); // 系统时间被调早一天
  75  |     await server.advance(30 * MIN); // 之后「过了」30 分钟，但仍早于游戏时间
  76  |     await page.getByRole('button', { name: '领取收益' }).click();
  77  |     await expect(page.getByText('暂无可领取的收益')).toBeVisible();
  78  |     expect(await progress(page)).toBe(2);
  79  | 
  80  |     await page.reload();
  81  |     await expect(page.locator('.card')).toBeVisible();
  82  |     await openActions(page);
> 83  |     await expect(page.getByRole('alert').filter({ hasText: '系统时间早于游戏时间' })).toBeVisible();
      |                                                                             ^ Error: expect(locator).toBeVisible() failed
  84  |   });
  85  | 
  86  |   test('系统时间被调到过去也不能跳过突破冷却', async ({ page, server }) => {
  87  |     await server.setPlayer({ realmProgress: 100 });
  88  |     await server.setRng(0.9999);
  89  |     await load(page, server.url);
  90  |     await openActions(page);
  91  |     await page.locator('.act.bt').click();
  92  |     await page.getByRole('button', { name: '确认突破' }).click();
  93  |     await expect(page.locator('.chip', { hasText: '经验 −20%' })).toBeVisible();
  94  | 
  95  |     await server.advance(-48 * HOUR); // 试图靠调早时间让冷却失效
  96  |     await server.setPlayer({ realmProgress: 100 });
  97  |     await page.reload();
  98  |     await openActions(page);
  99  |     await expect(page.locator('.act.bt')).toBeDisabled();
  100 |     await expect(page.locator('.act.bt')).toContainText('气息未平');
  101 |   });
  102 | });
  103 | 
```