/**
 * Visual Patrol — 全画面スクリーンショット自動巡回
 *
 * 使い方:
 *   npm run test:patrol
 *
 * 出力:
 *   tests/screenshots/YYYY-MM-DD/patrol-*.png
 *
 * YUUTAはスクショフォルダを開いて確認するだけ。
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, generateHtmlReport } from './helpers';

// 巡回対象ページ定義
const pages: { name: string; path: string; waitFor?: string; delay?: number }[] = [
  // ── メイン ──
  { name: 'patrol-01-dashboard',       path: '/',                                    waitFor: 'キャスト' },
  { name: 'patrol-02-casts',           path: '/casts',                               waitFor: 'キャスト' },
  { name: 'patrol-03-spy',             path: '/spy',                                 waitFor: 'SPY' },
  { name: 'patrol-04-alerts',          path: '/alerts',                              waitFor: 'アラート' },

  // ── キャスト詳細（hanshakun） ──
  { name: 'patrol-05-cast-overview',   path: '/casts/hanshakun?tab=overview',        waitFor: 'hanshakun', delay: 2000 },
  { name: 'patrol-06-cast-sessions',   path: '/casts/hanshakun?tab=sessions',        waitFor: 'セッション', delay: 2000 },
  { name: 'patrol-07-cast-dm',         path: '/casts/hanshakun?tab=dm',              waitFor: 'DM', delay: 2000 },
  { name: 'patrol-08-cast-analytics',  path: '/casts/hanshakun?tab=analytics',       waitFor: 'アナリティクス', delay: 3000 },
  { name: 'patrol-09-cast-settings',   path: '/casts/hanshakun?tab=settings',        waitFor: '設定', delay: 1000 },

  // ── SPY系 ──
  { name: 'patrol-10-spy-analysis',    path: '/spy/analysis',                        waitFor: '分析', delay: 2000 },

  // ── アラート系 ──
  { name: 'patrol-11-alerts-system',   path: '/alerts/system',                       waitFor: 'アラート', delay: 1000 },

  // ── Admin ──
  { name: 'patrol-12-admin-health',    path: '/admin/health',                        waitFor: '品質', delay: 2000 },
  { name: 'patrol-13-admin-revenue',   path: '/admin/revenue',                       waitFor: 'レベニュー', delay: 2000 },
  { name: 'patrol-14-admin-casts',     path: '/admin/casts',                         waitFor: 'キャスト', delay: 1000 },
  { name: 'patrol-15-admin-cmd',       path: '/admin/command-center',                waitFor: 'コマンド', delay: 2000 },
  { name: 'patrol-16-admin-dq',        path: '/admin/data-quality',                  waitFor: 'データ', delay: 2000 },
  { name: 'patrol-17-admin-testdata',  path: '/admin/test-data',                     waitFor: 'テスト', delay: 1000 },

  // ── その他 ──
  { name: 'patrol-18-reports',         path: '/reports',                             waitFor: 'レポート', delay: 1000 },
  { name: 'patrol-19-feed',            path: '/feed',                                waitFor: 'フィード', delay: 1000 },
];

// ── テスト本体 ──

test.describe('Visual Patrol — 全画面巡回', () => {
  const results: { name: string; path: string; ok: boolean; error: string }[] = [];

  test.beforeAll(async ({ browser }) => {
    // ログイン（1回だけ）
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    // ログイン後の認証状態を保存
    await ctx.storageState({ path: 'tests/e2e/.auth-state.json' });
    await ctx.close();
  });

  // 認証済みコンテキストを使い回す
  test.use({ storageState: 'tests/e2e/.auth-state.json' });

  for (const pg of pages) {
    test(pg.name, async ({ page }) => {
      const result = { name: pg.name, path: pg.path, ok: false, error: '' };

      try {
        // ページ遷移
        const resp = await page.goto(pg.path, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        // HTTP エラーチェック
        if (resp && resp.status() >= 400) {
          result.error = `HTTP ${resp.status()}`;
          results.push(result);
          // エラー画面もスクショに残す
          await saveScreenshot(page, pg.name);
          expect(resp.status()).toBeLessThan(400);
          return;
        }

        // コンテンツロード待ち
        if (pg.waitFor) {
          try {
            await page.getByText(pg.waitFor, { exact: false }).first().waitFor({
              state: 'visible',
              timeout: 10_000,
            });
          } catch {
            // waitFor テキストが見つからなくてもスクショは撮る
          }
        }

        // 追加の描画待ち（グラフ等の非同期レンダリング用）
        if (pg.delay) {
          await page.waitForTimeout(pg.delay);
        }

        // ローディングスピナーが消えるまで待つ
        try {
          await page.locator('[class*="animate-spin"]').first().waitFor({
            state: 'hidden',
            timeout: 5_000,
          });
        } catch {
          // スピナーがない場合は無視
        }

        // スクリーンショット撮影
        await saveScreenshot(page, pg.name);

        // エラーチェック
        const noErrors = await assertNoErrors(page);
        if (!noErrors) {
          result.error = 'ページにエラーあり';
        } else {
          result.ok = true;
        }
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
        // エラー時もスクショを試みる
        try { await saveScreenshot(page, pg.name); } catch { /* ignore */ }
      }

      results.push(result);
    });
  }

  test.afterAll(async () => {
    // ── 巡回結果サマリー出力 ──
    const total = results.length;
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);

    console.log('\n' + '='.repeat(60));
    console.log(`  Visual Patrol 結果: ${passed}/${total} OK`);
    console.log('='.repeat(60));

    if (failed.length > 0) {
      console.log('\n  ⚠ 問題あり:');
      for (const f of failed) {
        console.log(`    ✗ ${f.name} (${f.path}) — ${f.error}`);
      }
    }

    generateHtmlReport();
    const dir = 'tests/screenshots/' + new Date().toISOString().split('T')[0] + '/';
    console.log(`\n  スクショ保存先: ${dir}`);
    console.log(`  HTMLレポート: ${dir}index.html`);
    console.log('='.repeat(60) + '\n');
  });
});
