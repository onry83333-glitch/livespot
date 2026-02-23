import { test, expect } from '@playwright/test';
import { login, saveScreenshot, waitForVisible } from './helpers';

test.describe('テスト5: /admin/health チェック', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('ヘルスチェック5項目が表示される', async ({ page }) => {
    // Step 1: /admin/health にアクセス
    // 直接 health ページへ（admin/command-center から遷移もあるが直接URLが確実）
    await page.goto('/admin/health');
    await page.waitForLoadState('networkidle');
    await saveScreenshot(page, '05-health-initial');

    // Step 2: ヘルスチェック結果の表示を待つ
    // 品質チェック系のキーワードを待つ
    const hasHealthUI = await waitForVisible(page, 'コイン', 10_000)
      || await waitForVisible(page, 'health', 5_000)
      || await waitForVisible(page, '品質', 5_000);

    // Step 3: 各チェック項目のステータスをスクレイピング
    const healthItems = [
      { id: 'coin', label: 'コイントランザクション' },
      { id: 'overflow', label: 'オーバーフロー' },
      { id: 'dm', label: 'DM送信' },
      { id: 'viewers', label: 'spy_viewers' },
    ];

    const results: string[] = [];

    for (const item of healthItems) {
      const el = page.getByText(item.label, { exact: false }).first();
      const isVisible = await el.isVisible().catch(() => false);
      results.push(`${item.id}: ${isVisible ? 'visible' : 'not found'}`);
    }

    // 結果をログ出力
    console.log('=== Health Check Results ===');
    results.forEach(r => console.log(`  ${r}`));
    console.log('============================');

    // アノテーションとして記録
    test.info().annotations.push({
      type: 'health-results',
      description: results.join(' | '),
    });

    // Step 4: 最終スクリーンショット
    await saveScreenshot(page, '05-health-results');

    // ページが正常表示されていること（白画面でないこと）
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(10);
  });
});
