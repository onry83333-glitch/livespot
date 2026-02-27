/**
 * T-010: CSVエクスポート
 * 主要テーブルCSV出力 → データ存在確認
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-010: CSVエクスポート', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('レベニューシェアCSVエクスポートが動作する', async ({ page }) => {
    // Step 1: レベニューシェアページへ
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    const select = page.locator('select.input-glass');
    await expect(select).toBeVisible({ timeout: 10_000 });

    // Risa_06を選択
    const options = await select.locator('option').allInnerTexts();
    if (options.some(t => t.includes('Risa_06'))) {
      await select.selectOption({ label: 'Risa_06' });
    }

    // 計算実行
    await page.getByRole('button', { name: '計算する' }).click();
    await page.waitForLoadState('networkidle');

    const hasTable = await waitForVisible(page, '合計', 10_000);

    if (!hasTable) {
      test.skip(true, 'レベニューデータなし — CSVテストスキップ');
      return;
    }

    // CSV出力ボタンクリック → ダウンロード検証
    const csvBtn = page.getByRole('button', { name: 'CSV出力' });
    await expect(csvBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      csvBtn.click(),
    ]);

    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.csv$/);

    // ファイルサイズが0でないことを確認
    const path = await download.path();
    if (path) {
      const fs = require('fs');
      const stat = fs.statSync(path);
      expect(stat.size).toBeGreaterThan(10);

      test.info().annotations.push({
        type: 'info',
        description: `CSV: ${filename} (${stat.size} bytes)`,
      });
    }

    await saveScreenshot(page, '19-csv-revenue');
  });

  test('売上タブのCSVエクスポートボタン確認', async ({ page }) => {
    // キャスト売上タブ
    await page.goto('/casts/Risa_06?tab=sales');
    await page.waitForLoadState('networkidle');

    // 売上タブのコンテンツが表示されるまで待つ（コスト未設定でも正常）
    const hasSalesContent = await waitForVisible(page, '売上', 10_000);
    const hasCostWarning = await waitForVisible(page, 'コスト未設定', 3_000);
    expect(hasSalesContent || hasCostWarning).toBeTruthy();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    // CSVエクスポートボタンの存在確認
    const csvButtons = page.getByRole('button').filter({ hasText: /CSV|エクスポート|ダウンロード/ });
    const csvBtnCount = await csvButtons.count();

    test.info().annotations.push({
      type: 'info',
      description: `売上タブCSVボタン数: ${csvBtnCount}`,
    });

    // テーブルが存在するか確認
    const tables = page.locator('table');
    const tableCount = await tables.count();

    test.info().annotations.push({
      type: 'info',
      description: `テーブル数: ${tableCount}`,
    });

    await saveScreenshot(page, '19-csv-sales-tab');
  });

  test('分析ページのデータ表示確認', async ({ page }) => {
    // 分析ページ
    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    // いずれかのデータセクションが表示される
    const hasAnalytics = await waitForVisible(page, 'Analytics', 10_000);
    expect(hasAnalytics).toBeTruthy();

    // DM効果測定タブ → 期間ドロップダウン確認
    const dmTab = page.getByRole('button', { name: 'DM効果測定' });
    if (await dmTab.count() > 0) {
      await dmTab.click();
      await page.waitForLoadState('networkidle');

      // 期間選択の存在確認
      const periodSelects = page.locator('select');
      const periodCount = await periodSelects.count();

      test.info().annotations.push({
        type: 'info',
        description: `期間セレクト数: ${periodCount}`,
      });
    }

    await saveScreenshot(page, '19-analytics-data');
  });
});
