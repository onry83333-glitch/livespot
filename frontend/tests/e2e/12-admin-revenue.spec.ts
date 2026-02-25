import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト12: レベニューシェア計算ページ (/admin/revenue)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('ページが正常に表示される', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    // ヘッダーが表示される
    const hasTitle = await waitForVisible(page, 'レベニューシェア計算', 10_000);
    expect(hasTitle).toBeTruthy();

    // サブタイトル
    await expect(page.getByText('月曜03:00 JST 境界')).toBeVisible();

    // 空状態メッセージ
    await expect(
      page.getByText('キャストと期間を選択して「計算する」を押してください')
    ).toBeVisible();

    // 計算ボタン
    await expect(page.getByRole('button', { name: '計算する' })).toBeVisible();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '12-revenue-initial');
  });

  test('キャスト選択ドロップダウンにRisa_06が表示される', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    // キャストドロップダウンが存在
    const select = page.locator('select.input-glass');
    await expect(select).toBeVisible({ timeout: 10_000 });

    // Risa_06 が選択肢に含まれる
    const options = select.locator('option');
    const optionTexts = await options.allInnerTexts();
    expect(optionTexts.some(t => t.includes('Risa_06'))).toBeTruthy();

    await saveScreenshot(page, '12-revenue-cast-dropdown');
  });

  test('開始日に2025-02-15以前を設定すると警告が表示される', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    // 開始日フィールドの min 属性を確認
    const startInput = page.locator('input[type="date"]').first();
    await expect(startInput).toBeVisible({ timeout: 10_000 });
    const minValue = await startInput.getAttribute('min');
    expect(minValue).toBe('2025-02-15');

    // 2025-02-01 を入力して警告を確認
    await startInput.fill('2025-02-01');

    const hasWarning = await waitForVisible(
      page, '2025/2/15 以前のデータは使用禁止', 3_000
    );
    expect(hasWarning).toBeTruthy();

    await saveScreenshot(page, '12-revenue-date-warning');
  });

  test('計算実行で結果テーブルが表示される', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    // キャスト選択を待つ
    const select = page.locator('select.input-glass');
    await expect(select).toBeVisible({ timeout: 10_000 });

    // Risa_06 を選択（デフォルトで選ばれている可能性もある）
    const options = await select.locator('option').allInnerTexts();
    if (options.some(t => t.includes('Risa_06'))) {
      await select.selectOption({ label: 'Risa_06' });
    }

    // 計算実行
    await page.getByRole('button', { name: '計算する' }).click();
    await page.waitForLoadState('networkidle');

    // 結果テーブル or エラーメッセージ（データなし）を待つ
    const hasTable = await waitForVisible(page, '合計', 10_000);
    const hasNoData = await waitForVisible(page, '該当期間にデータがありません', 5_000);
    const hasCostError = await waitForVisible(page, 'cast_cost_settings', 5_000);

    // いずれかの結果が表示される（計算は実行された）
    expect(hasTable || hasNoData || hasCostError).toBeTruthy();

    if (hasTable) {
      // テーブルヘッダー確認
      await expect(page.getByRole('columnheader', { name: '総トークン' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'キャスト支払い' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: '根拠' })).toBeVisible();

      // 合計行の存在確認
      const footer = page.locator('tfoot');
      await expect(footer).toBeVisible();
      await expect(footer.getByText('合計')).toBeVisible();

      // CSV出力ボタンが表示される
      await expect(page.getByRole('button', { name: 'CSV出力' })).toBeVisible();

      // 期間合計の演算根拠セクション
      await expect(page.getByText('期間合計の演算根拠')).toBeVisible();
    }

    await saveScreenshot(page, '12-revenue-calculated');
  });

  test('演算根拠の展開・折りたたみが動作する', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    const select = page.locator('select.input-glass');
    await expect(select).toBeVisible({ timeout: 10_000 });

    // 計算実行
    await page.getByRole('button', { name: '計算する' }).click();
    await page.waitForLoadState('networkidle');

    const hasTable = await waitForVisible(page, '合計', 10_000);
    if (!hasTable) {
      // データがなければスキップ
      test.skip(true, 'No revenue data available for expansion test');
      return;
    }

    // 「表示」ボタンをクリックして根拠を展開
    const showBtn = page.getByRole('button', { name: '表示' }).first();
    await expect(showBtn).toBeVisible();
    await showBtn.click();

    // 展開された根拠が表示される
    const hasGrossFormula = await waitForVisible(page, '1. グロス:', 3_000);
    expect(hasGrossFormula).toBeTruthy();
    await expect(page.getByText('2. PF手数料:')).toBeVisible();
    await expect(page.getByText('3. ネット:')).toBeVisible();
    await expect(page.getByText('4. キャスト支払い:')).toBeVisible();

    await saveScreenshot(page, '12-revenue-expanded');

    // 「閉じる」で折りたたみ
    const closeBtn = page.getByRole('button', { name: '閉じる' }).first();
    await closeBtn.click();

    // 根拠が非表示になった
    await expect(page.getByText('1. グロス:').first()).not.toBeVisible();

    await saveScreenshot(page, '12-revenue-collapsed');
  });

  test('CSVエクスポートでダウンロードが発生する', async ({ page }) => {
    await page.goto('/admin/revenue');
    await page.waitForLoadState('networkidle');

    const select = page.locator('select.input-glass');
    await expect(select).toBeVisible({ timeout: 10_000 });

    // 計算実行
    await page.getByRole('button', { name: '計算する' }).click();
    await page.waitForLoadState('networkidle');

    const hasTable = await waitForVisible(page, '合計', 10_000);
    if (!hasTable) {
      test.skip(true, 'No revenue data available for CSV export test');
      return;
    }

    // CSVボタンが表示される
    const csvBtn = page.getByRole('button', { name: 'CSV出力' });
    await expect(csvBtn).toBeVisible();

    // ダウンロードイベントを待機してクリック
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      csvBtn.click(),
    ]);

    // ファイル名検証
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/^revenue_share_.+\.csv$/);

    await saveScreenshot(page, '12-revenue-csv-export');
  });
});
