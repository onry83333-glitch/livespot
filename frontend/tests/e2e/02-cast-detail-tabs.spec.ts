import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト2: キャスト詳細 → 全タブ表示確認', () => {
  // hanshakun のデータが多いためタイムアウトを拡張
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('hanshakun の各タブが正常表示される', async ({ page }) => {
    // Step 1: キャスト一覧ページへ
    await page.goto('/casts');
    await waitForVisible(page, '自社キャスト', 10_000);
    await saveScreenshot(page, '02-cast-list');

    // Step 2: hanshakun をクリック（直接遷移でも可）
    await page.goto('/casts/hanshakun');
    await page.waitForLoadState('networkidle');
    await saveScreenshot(page, '02-cast-hanshakun-overview');

    // Step 3: 各タブを順にクリックしてスクリーンショット保存
    const tabs = [
      { key: 'sessions', label: '配信' },
      { key: 'dm', label: 'DM' },
      { key: 'analytics', label: '分析' },
      { key: 'sales', label: '売上' },
      { key: 'realtime', label: 'リアルタイム' },
      { key: 'overlap', label: '競合分析' },
    ];

    for (const tab of tabs) {
      await page.goto(`/casts/hanshakun?tab=${tab.key}`);
      await page.waitForLoadState('networkidle');

      // エラーがないことを確認
      const noErrors = await assertNoErrors(page);
      expect(noErrors).toBeTruthy();

      await saveScreenshot(page, `02-tab-${tab.key}`);
    }
  });
});
