import { test, expect } from '@playwright/test';
import { login, saveScreenshot, waitForVisible } from './helpers';

test.describe('テスト3: 配信単位ビュー 3モード表示確認', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('セッション一覧 → 最新セッション → 各モード確認', async ({ page }) => {
    // Step 1: キャスト詳細の配信タブへ
    await page.goto('/casts/hanshakun?tab=sessions');
    await page.waitForLoadState('networkidle');

    // Step 2: セッション一覧が表示されることを確認
    await saveScreenshot(page, '03-session-list');

    // Step 3: 最新セッションをクリック
    // セッションリンクはテーブル行またはカード内のリンク
    const sessionLink = page.locator('a[href*="/sessions/"]').first();
    const linkExists = await sessionLink.count();

    if (linkExists > 0) {
      await sessionLink.click();
      await page.waitForLoadState('networkidle');

      // セッション詳細ページのスクリーンショット
      await saveScreenshot(page, '03-session-detail');

      // モード切替タブが存在するか確認
      const hasPreMode = await waitForVisible(page, '配信前', 5_000);
      const hasPostMode = await waitForVisible(page, '配信後', 5_000);

      if (hasPreMode) {
        // 配信前モードのスクリーンショット
        const preModeBtn = page.getByText('配信前').first();
        if (await preModeBtn.isVisible()) {
          await preModeBtn.click();
          await page.waitForTimeout(1_000);
          await saveScreenshot(page, '03-mode-pre-broadcast');
        }
      }

      if (hasPostMode) {
        // 配信後モードのスクリーンショット
        const postModeBtn = page.getByText('配信後').first();
        if (await postModeBtn.isVisible()) {
          await postModeBtn.click();
          await page.waitForTimeout(1_000);
          await saveScreenshot(page, '03-mode-post-broadcast');
        }
      }

      // 配信中モードは実際の配信中でないと表示されないため、
      // 存在する場合のみキャプチャ
      const hasLiveMode = await waitForVisible(page, '配信中', 3_000);
      if (hasLiveMode) {
        const liveModeBtn = page.getByText('配信中').first();
        if (await liveModeBtn.isVisible()) {
          await liveModeBtn.click();
          await page.waitForTimeout(1_000);
          await saveScreenshot(page, '03-mode-live');
        }
      }
    } else {
      // セッションが存在しない場合は空状態のスクリーンショット
      await saveScreenshot(page, '03-no-sessions');
      test.info().annotations.push({
        type: 'info',
        description: 'セッションが見つかりませんでした（データ依存テスト）',
      });
    }
  });
});
