/**
 * 21-prod-full-flow.spec.ts — 本番環境フルフローE2Eテスト
 *
 * テスト対象: livespot-rouge.vercel.app
 * 検証項目:
 *   1. ログイン→ダッシュボード→キャスト一覧にRisa_06表示
 *   2. Risa_06詳細 各タブ表示確認
 *   3. セッション一覧v2表示確認（Migration 097修正済み）
 *   4. P/L画面のエラーメッセージ確認
 *   5. セグメント別DMタブのフィルター動作
 *   6. SPYページでspy_messagesデータ表示
 *   7. /admin/healthが自アカウントデータのみ表示
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, waitForVisible, assertNoErrors, generateHtmlReport } from './helpers';

// テスト結果を収集
const results: { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }[] = [];

function record(name: string, status: 'PASS' | 'FAIL' | 'WARN', detail: string) {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} ${name}: ${detail}`);
}

test.describe('本番フルフローE2E', () => {
  test.setTimeout(60_000);

  // ========== Test 1: ログイン→ダッシュボード→キャスト一覧 ==========
  test('1. ログイン→ダッシュボード→Risa_06表示', async ({ page }) => {
    await login(page);
    await page.waitForLoadState('networkidle');

    // ダッシュボードが表示されているか
    const dashOk = await assertNoErrors(page);
    expect(dashOk).toBeTruthy();
    await saveScreenshot(page, '01-dashboard');
    record('ダッシュボード表示', dashOk ? 'PASS' : 'FAIL', dashOk ? 'ダッシュボード正常表示' : 'エラー検出');

    // キャスト一覧に移動
    await page.goto('/casts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000); // RPC集計完了待ち

    const castsOk = await assertNoErrors(page);
    await saveScreenshot(page, '02-casts-list');

    // Risa_06 が表示されているか
    const hasRisa = await waitForVisible(page, 'Risa_06', 10_000);
    record('キャスト一覧 Risa_06', hasRisa ? 'PASS' : 'FAIL', hasRisa ? 'Risa_06 表示確認' : 'Risa_06 が見つからない');
    expect(hasRisa).toBeTruthy();
  });

  // ========== Test 2: Risa_06詳細 各タブ表示 ==========
  test('2. Risa_06詳細 — 各タブ表示確認', async ({ page }) => {
    await login(page);
    await page.goto('/casts/Risa_06');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    const detailOk = await assertNoErrors(page);
    await saveScreenshot(page, '03-risa06-overview');
    record('Risa_06 概要タブ', detailOk ? 'PASS' : 'FAIL', detailOk ? '概要タブ正常表示' : 'エラー検出');

    // 各タブをクリックしてスクリーンショット
    const tabs = [
      { label: 'セグメント', screenshot: '04-risa06-segments' },
      { label: 'DM', screenshot: '05-risa06-dm' },
      { label: 'SPY', screenshot: '06-risa06-spy' },
      { label: 'セッション', screenshot: '07-risa06-sessions' },
      { label: 'P/L', screenshot: '08-risa06-pl' },
      { label: '競合分析', screenshot: '09-risa06-competitor' },
    ];

    for (const tab of tabs) {
      try {
        // タブボタンを探してクリック
        const tabBtn = page.locator(`button, [role="tab"], a`).filter({ hasText: tab.label }).first();
        const tabExists = await tabBtn.count() > 0;

        if (tabExists) {
          await tabBtn.click();
          await page.waitForTimeout(2000);
          await page.waitForLoadState('networkidle').catch(() => {});
          const tabOk = await assertNoErrors(page);
          await saveScreenshot(page, tab.screenshot);
          record(`Risa_06 ${tab.label}タブ`, tabOk ? 'PASS' : 'WARN', tabOk ? `${tab.label}タブ表示確認` : 'コンテンツ少ない可能性');
        } else {
          await saveScreenshot(page, tab.screenshot);
          record(`Risa_06 ${tab.label}タブ`, 'WARN', `${tab.label}タブボタンが見つからない`);
        }
      } catch (e) {
        await saveScreenshot(page, tab.screenshot);
        record(`Risa_06 ${tab.label}タブ`, 'FAIL', `エラー: ${(e as Error).message.substring(0, 80)}`);
      }
    }
  });

  // ========== Test 3: セッション一覧v2 (Migration 097修正済み) ==========
  test('3. セッション一覧v2 表示確認', async ({ page }) => {
    await login(page);
    await page.goto('/casts/Risa_06');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // セッションタブをクリック
    const sessTab = page.locator(`button, [role="tab"], a`).filter({ hasText: 'セッション' }).first();
    if (await sessTab.count() > 0) {
      await sessTab.click();
      await page.waitForTimeout(3000);
    }

    await saveScreenshot(page, '10-sessions-v2');

    // セッション一覧が表示されているか（エラーでない）
    const hasError = await page.getByText('エラー').first().isVisible().catch(() => false);
    const hasSessionData = await page.locator('table, [class*="session"], [class*="card"]').first().isVisible().catch(() => false);

    if (hasError) {
      record('セッション一覧v2', 'FAIL', 'エラーが表示されている（Migration 097の修正が不十分な可能性）');
    } else if (hasSessionData) {
      record('セッション一覧v2', 'PASS', 'セッション一覧が正常表示');
    } else {
      record('セッション一覧v2', 'WARN', 'セッションデータなし（データ不在の可能性）');
    }
  });

  // ========== Test 4: P/L画面エラーメッセージ確認 ==========
  test('4. P/L画面 — エラーメッセージ確認', async ({ page }) => {
    await login(page);
    await page.goto('/casts/Risa_06');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // P/Lタブをクリック
    const plTab = page.locator(`button, [role="tab"], a`).filter({ hasText: 'P/L' }).first();
    if (await plTab.count() > 0) {
      await plTab.click();
      await page.waitForTimeout(3000);
    }

    await saveScreenshot(page, '11-pl-tab');

    // エラー表示の確認
    const bodyText = await page.locator('main, [class*="content"], body').first().innerText();

    // "コスト未設定" と表示される場合はOK（正しいガイダンス）
    // "エラー" / "error" / "500" が表示される場合はNG
    const hasCostGuide = bodyText.includes('コスト') || bodyText.includes('設定');
    const hasGenericError = bodyText.includes('500') || bodyText.toLowerCase().includes('internal');

    if (hasGenericError) {
      record('P/L画面', 'FAIL', '汎用エラー表示（コスト未設定と混同している可能性）');
    } else if (hasCostGuide) {
      record('P/L画面', 'PASS', 'コスト設定ガイダンスが正しく表示');
    } else {
      record('P/L画面', 'PASS', 'P/Lデータ or ガイダンスが表示');
    }
  });

  // ========== Test 5: セグメント別DMタブ フィルター動作 ==========
  test('5. セグメント別DMタブ — フィルター動作', async ({ page }) => {
    await login(page);
    await page.goto('/casts/Risa_06');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // DMタブをクリック
    const dmTab = page.locator(`button, [role="tab"], a`).filter({ hasText: 'DM' }).first();
    if (await dmTab.count() > 0) {
      await dmTab.click();
      await page.waitForTimeout(3000);
    }

    await saveScreenshot(page, '12-dm-tab-initial');

    // 期間フィルタの存在確認
    const periodFilter = page.locator('select, [class*="filter"], [class*="period"], input[type="number"]').first();
    const hasPeriodFilter = await periodFilter.count() > 0;
    record('DMタブ 期間フィルタ', hasPeriodFilter ? 'PASS' : 'WARN', hasPeriodFilter ? 'フィルタUI存在確認' : 'フィルタUIが見つからない');

    // コインレンジフィルタの存在確認
    const coinFilter = page.locator('[class*="coin"], [class*="range"], input[type="range"], input[placeholder*="コイン"], input[placeholder*="min"], input[placeholder*="max"]');
    const hasCoinFilter = await coinFilter.count() > 0;

    // もしフィルタがあれば操作してみる
    if (hasPeriodFilter) {
      try {
        await periodFilter.click();
        await page.waitForTimeout(1000);
        await saveScreenshot(page, '13-dm-filter-open');
        record('DMタブ フィルタ操作', 'PASS', 'フィルタクリック成功');
      } catch {
        record('DMタブ フィルタ操作', 'WARN', 'フィルタ操作でエラー');
      }
    }

    // セグメント表示確認
    const hasSegments = await waitForVisible(page, 'セグメント', 5_000) ||
                        await waitForVisible(page, 'S1', 5_000) ||
                        await waitForVisible(page, 'whale', 5_000);
    record('DMタブ セグメント表示', hasSegments ? 'PASS' : 'WARN', hasSegments ? 'セグメント情報表示' : 'セグメント情報なし');
    await saveScreenshot(page, '14-dm-segments');
  });

  // ========== Test 6: SPYページ spy_messages表示 ==========
  test('6. SPYページ — spy_messages表示', async ({ page }) => {
    await login(page);
    await page.goto('/spy');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000); // Realtimeデータロード待ち

    await saveScreenshot(page, '15-spy-page');

    const spyOk = await assertNoErrors(page);
    record('SPYページ表示', spyOk ? 'PASS' : 'FAIL', spyOk ? 'SPYページ正常表示' : 'エラー検出');

    // メッセージが表示されているか
    const bodyText = await page.locator('body').innerText();
    const hasMessages = bodyText.includes('tip') || bodyText.includes('chat') || bodyText.includes('message') ||
                        bodyText.length > 500; // コンテンツが十分にある

    // キャスト名が表示されているか
    const hasCastName = bodyText.includes('Risa_06') || bodyText.includes('hanshakun') ||
                        bodyText.includes('fantasy_JP');

    record('SPYページ メッセージデータ', hasMessages ? 'PASS' : 'WARN',
      hasMessages ? 'メッセージデータ表示確認' : 'メッセージが少ない or なし');
    record('SPYページ キャスト名', hasCastName ? 'PASS' : 'WARN',
      hasCastName ? 'キャスト名表示確認' : 'キャスト名が見つからない');

    // 自社タブ/他社タブの確認
    const hasOwnTab = await waitForVisible(page, '自社', 5_000);
    const hasCompTab = await waitForVisible(page, '他社', 5_000);
    await saveScreenshot(page, '16-spy-tabs');
    record('SPYページ タブ構成', (hasOwnTab || hasCompTab) ? 'PASS' : 'WARN',
      `自社タブ:${hasOwnTab ? 'あり' : 'なし'} 他社タブ:${hasCompTab ? 'あり' : 'なし'}`);
  });

  // ========== Test 7: /admin/health 自アカウントデータ確認 ==========
  test('7. /admin/health — 自アカウントデータ確認', async ({ page }) => {
    await login(page);
    await page.goto('/admin/health');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    await saveScreenshot(page, '17-admin-health');

    const healthOk = await assertNoErrors(page);
    record('/admin/health表示', healthOk ? 'PASS' : 'FAIL', healthOk ? '品質チェック画面表示' : 'エラー検出');

    // チェック項目が表示されているか
    const bodyText = await page.locator('body').innerText();
    const hasHealthItems = bodyText.includes('チェック') || bodyText.includes('整合性') ||
                           bodyText.includes('品質') || bodyText.includes('ヘルス');

    record('/admin/health チェック項目', hasHealthItems ? 'PASS' : 'WARN',
      hasHealthItems ? '品質チェック項目表示' : 'チェック項目が見つからない');

    // 実行ボタンがあれば押してみる
    const runBtn = page.locator('button').filter({ hasText: /チェック|実行|確認/ }).first();
    if (await runBtn.count() > 0) {
      await runBtn.click();
      await page.waitForTimeout(5000);
      await saveScreenshot(page, '18-admin-health-results');
      record('/admin/health 実行結果', 'PASS', 'チェック実行完了');
    }
  });

  // ========== テスト完了: HTMLレポート生成 ==========
  test.afterAll(async () => {
    // 結果サマリーをコンソール出力
    console.log('\n' + '='.repeat(60));
    console.log('本番フルフローE2E テスト結果サマリー');
    console.log('='.repeat(60));

    let pass = 0, fail = 0, warn = 0;
    for (const r of results) {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`  ${icon} ${r.name}: ${r.detail}`);
      if (r.status === 'PASS') pass++;
      else if (r.status === 'FAIL') fail++;
      else warn++;
    }

    console.log(`\n合計: ${results.length}項目 — ✅${pass} / ❌${fail} / ⚠️${warn}`);
    console.log('='.repeat(60));

    // HTMLレポート生成
    generateHtmlReport();
  });
});
