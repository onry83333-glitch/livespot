import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// スクリーンショット保存先: tests/screenshots/YYYY-MM-DD/
const today = new Date().toISOString().split('T')[0];
const screenshotDir = path.join(__dirname, 'tests', 'screenshots', today);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // ログインセッション共有のため直列実行
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  timeout: 30_000, // Supabase Realtime接続待ちを考慮

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    screenshot: 'off', // テスト内で手動撮影
    trace: 'on-first-retry',
    video: 'off',
  },

  outputDir: screenshotDir,

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
