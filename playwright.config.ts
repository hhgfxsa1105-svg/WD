import { defineConfig } from '@playwright/test';

// 本机无 Playwright 浏览器时，可用 PW_CHROMIUM_PATH 指向已安装的 Chromium；否则先执行 `npx playwright install chromium`
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
    viewport: { width: 390, height: 800 },
  },
});
