/**
 * Chrome拡張 Popup UI スクリーンショット撮影
 *
 * 3パターン:
 *   1. 未ログイン状態（ログインフォーム表示）
 *   2. ログイン済み状態（ダッシュボード表示 + キャスト検出OK）
 *   3. 複数アカウント警告状態（警告バナー + リセットボタン）
 *
 * 実行: npx tsx screenshots/chrome-extension/capture-popup.ts
 */
import { chromium } from 'playwright';
import * as path from 'path';

const POPUP_PATH = path.resolve(__dirname, '../../chrome-extension/popup.html');
const OUT_DIR = __dirname;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 380, height: 600 } });

  // --- 1. 未ログイン状態 ---
  {
    const page = await context.newPage();
    await page.route('**/popup.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: '/* blocked */',
    }));
    await page.goto(`file:///${POPUP_PATH.replace(/\\/g, '/')}`);
    await page.waitForLoadState('domcontentloaded');

    // HTMLデフォルト: loginSection表示、disconnected状態
    const outPath = path.join(OUT_DIR, '01_popup_not_logged_in.png');
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`✓ ${outPath}`);
    await page.close();
  }

  // --- 2. ログイン済み状態 ---
  {
    const page = await context.newPage();
    await page.route('**/popup.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: '/* blocked */',
    }));
    await page.goto(`file:///${POPUP_PATH.replace(/\\/g, '/')}`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      document.getElementById('loginSection')!.classList.add('hidden');
      document.getElementById('dashboardSection')!.classList.remove('hidden');

      const dot = document.getElementById('statusDot')!;
      dot.className = 'status-dot connected';
      document.getElementById('statusText')!.textContent = '接続中';

      const select = document.getElementById('accountSelect') as HTMLSelectElement;
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '940e7248';
      opt.textContent = 'stripchat_main';
      opt.selected = true;
      select.appendChild(opt);

      const section = document.getElementById('castIdentitySection')!;
      section.style.display = 'flex';
      section.className = 'cast-identity ok';
      document.getElementById('castIdentityIcon')!.innerHTML = '\u25CF';
      document.getElementById('castIdentityText')!.innerHTML =
        'ログイン中: <span class="cast-identity-name">hanshakun</span>';
      document.getElementById('clearCookiesBtn')!.style.display = 'block';

      const castSelect = document.getElementById('coinSyncCastSelect') as HTMLSelectElement;
      castSelect.innerHTML = '';
      ['hanshakun', 'Risa_06'].forEach(name => {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        castSelect.appendChild(o);
      });

      const syncStatus = document.getElementById('coinSyncStatus')!;
      syncStatus.classList.remove('hidden');
      syncStatus.innerHTML = '<span style="color:#475569;">前回: 2026/03/01 14:30:00 (1,247件)</span>';
    });

    const outPath = path.join(OUT_DIR, '02_popup_logged_in.png');
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`✓ ${outPath}`);
    await page.close();
  }

  // --- 3. 複数アカウント警告状態 ---
  {
    const page = await context.newPage();
    await page.route('**/popup.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: '/* blocked */',
    }));
    await page.goto(`file:///${POPUP_PATH.replace(/\\/g, '/')}`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => {
      document.getElementById('loginSection')!.classList.add('hidden');
      document.getElementById('dashboardSection')!.classList.remove('hidden');

      const dot = document.getElementById('statusDot')!;
      dot.className = 'status-dot connected';
      document.getElementById('statusText')!.textContent = '接続中';

      const select = document.getElementById('accountSelect') as HTMLSelectElement;
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '940e7248';
      opt.textContent = 'stripchat_main';
      opt.selected = true;
      select.appendChild(opt);

      const section = document.getElementById('castIdentitySection')!;
      section.style.display = 'flex';
      section.className = 'cast-identity warning';
      document.getElementById('castIdentityIcon')!.innerHTML = '\u26A0';
      document.getElementById('castIdentityText')!.innerHTML =
        '<strong>複数アカウント検出!</strong><br>' +
        '<span style="font-size:10px;">ID: 12345678, 87654321<br>' +
        '「リセット」を押してcookieをクリアし、正しいキャストで再ログインしてください。<br>' +
        '<strong>この状態ではDM送信はブロックされます。</strong></span>';
      document.getElementById('clearCookiesBtn')!.style.display = 'block';

      const castSelect = document.getElementById('coinSyncCastSelect') as HTMLSelectElement;
      castSelect.innerHTML = '<option value="">キャストを選択</option>';
    });

    const outPath = path.join(OUT_DIR, '03_popup_multiple_accounts_warning.png');
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`✓ ${outPath}`);
    await page.close();
  }

  await browser.close();
  console.log('\n完了: 3枚のスクリーンショットを保存しました');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
