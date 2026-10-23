# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: prototype.spec.ts >> 快速连点修炼只结算一次
- Location: e2e/prototype.spec.ts:40:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 2
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation "功能入口" [ref=e4]:
    - button "设置" [ref=e5] [cursor=pointer]
    - button "任务" [ref=e10] [cursor=pointer]
    - button "消息" [ref=e15] [cursor=pointer]
  - main [ref=e21]:
    - region "角色" [ref=e22]:
      - generic [ref=e23]:
        - generic [ref=e24]:
          - button "林惊鸿" [ref=e25] [cursor=pointer]
          - generic [ref=e26]:
            - text: 头衔山门弟子
            - emphasis [ref=e27]: 凡
        - generic [ref=e28]:
          - generic [ref=e29]:
            - generic [ref=e30]:
              - generic [ref=e31]: 元宝
              - generic [ref=e32]: "0"
            - generic [ref=e33]:
              - generic [ref=e34]: 银两
              - generic [ref=e35]: "10"
            - generic [ref=e36]:
              - generic [ref=e37]: 铜钱
              - generic [ref=e38]: "320"
          - generic [ref=e39]: 炼体
          - progressbar "晋级进度" [ref=e40]
      - generic "六维" [ref=e42]:
        - generic [ref=e43]:
          - term [ref=e44]: 神
          - definition [ref=e45]: "5"
        - generic [ref=e46]:
          - term [ref=e47]: 力
          - definition [ref=e48]: "5"
        - generic [ref=e49]:
          - term [ref=e50]: 敏
          - definition [ref=e51]: "5"
        - generic [ref=e52]:
          - term [ref=e53]: 根
          - definition [ref=e54]: "5"
        - generic [ref=e55]:
          - term [ref=e56]: 悟
          - definition [ref=e57]: "5"
        - generic [ref=e58]:
          - term [ref=e59]: 福
          - definition [ref=e60]: "5"
      - generic [ref=e61]:
        - generic [ref=e62]:
          - generic [ref=e63]: 气血
          - progressbar "气血" [ref=e64]
          - generic [ref=e66]: 100/100
        - generic [ref=e67]:
          - generic [ref=e68]: 体力
          - progressbar "体力" [ref=e69]
          - generic [ref=e71]: 30/50
    - generic [ref=e72]:
      - generic [ref=e73]:
        - generic [ref=e74]: 位置
        - strong [ref=e75]: 青云山 · 山门
      - generic [ref=e76]: 晴 · 午时
    - region "日志" [ref=e77]:
      - generic [ref=e78]:
        - generic [ref=e79]: 日志
        - generic [ref=e80]: 3 条
      - list [ref=e81]:
        - listitem [ref=e82]:
          - time [ref=e83]: 辰时
          - paragraph [ref=e85]: 你醒来时，天光尚淡。远处山门钟声一响，今日的江湖便开始了。
        - listitem [ref=e86]:
          - time [ref=e87]: 巳时
          - generic [ref=e88]:
            - paragraph [ref=e89]: 你盘膝而坐，运转功法，一周天下来，只觉经脉微微发热。
            - generic [ref=e90]:
              - generic [ref=e91]: 体力 −10
              - generic [ref=e92]: 经验 +11%
        - listitem [ref=e93]:
          - time [ref=e94]: 午时
          - generic [ref=e95]:
            - paragraph [ref=e96]: 你盘膝而坐，运转功法，一周天下来，只觉经脉微微发热。
            - generic [ref=e97]:
              - generic [ref=e98]: 体力 −10
              - generic [ref=e99]: 经验 +11%
    - group "主导航" [ref=e101]:
      - button "背包" [ref=e102] [cursor=pointer]
      - button "功法" [ref=e103] [cursor=pointer]
      - button "地图" [ref=e104] [cursor=pointer]
      - button "行动" [pressed] [ref=e105] [cursor=pointer]
    - dialog "行动" [ref=e106]:
      - generic [ref=e107]:
        - heading "行动" [level=3] [ref=e108]
        - button "收起" [ref=e109] [cursor=pointer]
      - generic [ref=e110]:
        - button "修炼 体力 −10 · 获得经验" [active] [ref=e111] [cursor=pointer]:
          - strong [ref=e112]: 修炼
          - generic [ref=e113]: 体力 −10 · 获得经验
        - button "休息 体力 +15 · 气血 +5" [ref=e114] [cursor=pointer]:
          - strong [ref=e115]: 休息
          - generic [ref=e116]: 体力 +15 · 气血 +5
      - generic [ref=e117]:
        - textbox "自由行动输入" [disabled] [ref=e118]:
          - /placeholder: 自由行动将在 AI 接入后开放（S3）
        - button "行动" [disabled] [ref=e119]
```

# Test source

```ts
  1   | import type { Page } from '@playwright/test';
  2   | import { expect, test } from './fixtures';
  3   | 
  4   | const stamina = async (page: Page) => Number(await page.getByRole('progressbar', { name: '体力' }).getAttribute('aria-valuenow'));
  5   | const progress = async (page: Page) => Number(await page.getByRole('progressbar', { name: '晋级进度' }).getAttribute('aria-valuenow'));
  6   | const openActions = (page: Page) => page.getByRole('button', { name: '行动', exact: true }).click();
  7   | const cultivate = (page: Page) => page.locator('.act', { hasText: '修炼' });
  8   | const rest = (page: Page) => page.locator('.act', { hasText: '休息' });
  9   | 
  10  | test.beforeEach(async ({ page, server }) => {
  11  |   await page.goto(server.url);
  12  |   await expect(page.locator('.card')).toBeVisible();
  13  | });
  14  | 
  15  | test('首页展示角色：炼体无内力、六维、三种货币', async ({ page }) => {
  16  |   await expect(page.getByRole('button', { name: '林惊鸿' })).toBeVisible();
  17  |   await expect(page.locator('.realm')).toHaveText('炼体');
  18  |   await expect(page.getByRole('progressbar', { name: '气血' })).toBeVisible();
  19  |   await expect(page.getByRole('progressbar', { name: '内力' })).toHaveCount(0);
  20  |   await expect(page.locator('.six dt')).toHaveText(['神', '力', '敏', '根', '悟', '福']);
  21  |   await expect(page.locator('.money i')).toHaveText(['元宝', '银两', '铜钱']);
  22  | });
  23  | 
  24  | test('点击名字展开称号与命格，可用再点、空白处、Esc 收回', async ({ page }) => {
  25  |   const name = page.getByRole('button', { name: '林惊鸿' });
  26  |   const pop = page.locator('#namePop');
  27  |   await name.click();
  28  |   await expect(pop).toContainText('初出茅庐');
  29  |   await expect(pop).toContainText('七杀');
  30  |   await name.click();
  31  |   await expect(pop).toHaveCount(0);
  32  |   await name.click();
  33  |   await page.mouse.click(5, 5);
  34  |   await expect(pop).toHaveCount(0);
  35  |   await name.click();
  36  |   await page.keyboard.press('Escape');
  37  |   await expect(pop).toHaveCount(0);
  38  | });
  39  | 
  40  | test('快速连点修炼只结算一次', async ({ page }) => {
  41  |   let posts = 0;
  42  |   page.on('request', (r) => r.method() === 'POST' && r.url().includes('/api/v1/actions') && posts++);
  43  |   await openActions(page);
  44  |   await cultivate(page).dblclick();
  45  |   await expect(page.locator('.chip').first()).toBeVisible();
> 46  |   expect(posts).toBe(1);
      |                 ^ Error: expect(received).toBe(expected) // Object.is equality
  47  |   expect(await stamina(page)).toBe(40);
  48  | });
  49  | 
  50  | test('体力耗尽后修炼禁用并提示，休息后恢复', async ({ page }) => {
  51  |   await openActions(page);
  52  |   for (let i = 0; i < 5; i++) {
  53  |     const before = await page.locator('.entry').count();
  54  |     await cultivate(page).click();
  55  |     await expect(page.locator('.entry')).toHaveCount(before + 1);
  56  |   }
  57  |   expect(await stamina(page)).toBe(0);
  58  |   expect(await progress(page)).toBe(55);
  59  |   await expect(cultivate(page)).toBeDisabled();
  60  |   await expect(page.getByText('体力不足，先休息一下。')).toBeVisible();
  61  |   await rest(page).click();
  62  |   await expect(page.locator('.entry')).toHaveCount(7);
  63  |   expect(await stamina(page)).toBe(15);
  64  |   await expect(cultivate(page)).toBeEnabled();
  65  | });
  66  | 
  67  | test('刷新页面后状态保持', async ({ page }) => {
  68  |   await openActions(page);
  69  |   await cultivate(page).click();
  70  |   await expect(page.locator('.chip').first()).toBeVisible();
  71  |   await page.reload();
  72  |   await expect(page.locator('.card')).toBeVisible();
  73  |   expect(await stamina(page)).toBe(40);
  74  |   expect(await progress(page)).toBe(11);
  75  | });
  76  | 
  77  | test('重启服务后存档保留', async ({ page, server }) => {
  78  |   await openActions(page);
  79  |   await cultivate(page).click();
  80  |   await expect(page.locator('.chip').first()).toBeVisible();
  81  |   await server.restart();
  82  |   await page.reload();
  83  |   await expect(page.locator('.card')).toBeVisible();
  84  |   expect(await stamina(page)).toBe(40);
  85  | });
  86  | 
  87  | test('服务不可用时行动给出可读提示；读档失败可重试', async ({ page, server }) => {
  88  |   await openActions(page);
  89  |   await page.route('**/api/v1/actions', (r) => r.abort());
  90  |   await rest(page).click();
  91  |   await expect(page.getByRole('alert')).toContainText('无法连接本地服务');
  92  |   await page.unroute('**/api/v1/actions');
  93  | 
  94  |   const p2 = await page.context().newPage();
  95  |   await p2.route('**/api/v1/player/state', (r) => r.abort());
  96  |   await p2.goto(server.url);
  97  |   await expect(p2.getByRole('alert')).toContainText('无法连接本地服务');
  98  |   await p2.unroute('**/api/v1/player/state');
  99  |   await p2.getByRole('button', { name: '重试' }).click();
  100 |   await expect(p2.locator('.card')).toBeVisible();
  101 | });
  102 | 
  103 | for (const [name, width] of [['手机 390', 390], ['小屏 320', 320], ['桌面 1280', 1280]] as const) {
  104 |   test(`布局：${name} 无横向滚动，面板不遮挡底部导航`, async ({ page }) => {
  105 |     await page.setViewportSize({ width, height: 800 });
  106 |     await openActions(page);
  107 |     await expect(page.locator('.sheet')).toBeVisible();
  108 |     const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  109 |     expect(noHScroll).toBe(true);
  110 |     const sheet = await page.locator('.sheet').boundingBox();
  111 |     const nav = await page.locator('.nav-wrap').boundingBox();
  112 |     expect(sheet!.y + sheet!.height).toBeLessThanOrEqual(nav!.y + 1);
  113 |   });
  114 | }
  115 | 
```