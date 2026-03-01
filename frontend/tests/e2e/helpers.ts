import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// .env.test から環境変数を読み込み
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.test') });

export const TEST_EMAIL = process.env.E2E_TEST_EMAIL || 'admin@livespot.jp';
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'livespot2024';

/** スクリーンショット保存先ディレクトリ（tests/screenshots/YYYY-MM-DD/） */
function getScreenshotDir(): string {
  const today = new Date().toISOString().split('T')[0];
  const dir = path.join(__dirname, '..', 'screenshots', today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 命名規則付きスクリーンショット保存 */
export async function saveScreenshot(page: Page, name: string): Promise<void> {
  const dir = getScreenshotDir();
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
}

/** ログイン処理（全テストで共通利用） */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');

  // 既にログイン済みでダッシュボードにリダイレクトされた場合はスキップ
  const currentUrl = page.url();
  if (!currentUrl.includes('/login')) {
    return;
  }

  // ログインフォームが表示されるまで待つ（レート制限や遅延に対応）
  const emailInput = page.getByPlaceholder('you@example.com');
  await emailInput.waitFor({ state: 'visible', timeout: 15_000 });

  await emailInput.fill(TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();

  // ダッシュボードへのリダイレクトを待つ
  await page.waitForURL('/', { timeout: 15_000 });
}

/** ページ内に致命的エラー表示がないことを確認 */
export async function assertNoErrors(page: Page): Promise<boolean> {
  // Next.js のエラーページ or 致命的エラーのみチェック
  // "404" や "エラー" といった一般的な文字列はコンテンツ内に含まれうるため除外
  const title = await page.title();
  if (title.includes('404') || title.includes('500')) return false;

  // Next.js エラーオーバーレイの検出
  const errorOverlay = page.locator('nextjs-portal, [data-nextjs-dialog]');
  if (await errorOverlay.count() > 0) return false;

  // 白画面チェック（bodyのテキストが極端に短い）
  const bodyText = await page.locator('body').innerText();
  if (bodyText.trim().length < 20) return false;

  return true;
}

/** 要素が表示されるまで待つ（soft wait） */
export async function waitForVisible(page: Page, text: string, timeout = 10_000): Promise<boolean> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** スクショフォルダにHTMLインデックスを生成（ブラウザで一覧確認用） */
export function generateHtmlReport(screenshotDir?: string): void {
  const dir = screenshotDir || getScreenshotDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  if (files.length === 0) return;

  const date = path.basename(dir);
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>LiveSpot スクリーンショット — ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0f1e; color: #f1f5f9; font-family: 'Segoe UI', sans-serif; padding: 24px; }
  h1 { color: #38bdf8; font-size: 24px; margin-bottom: 4px; }
  .meta { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
  .card { background: rgba(15,23,42,0.7); border: 1px solid rgba(56,189,248,0.1); border-radius: 8px; overflow: hidden; transition: border-color 0.2s; }
  .card:hover { border-color: rgba(56,189,248,0.3); }
  .card img { width: 100%; display: block; cursor: pointer; }
  .card .label { padding: 8px 12px; font-size: 13px; color: #94a3b8; }
  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 100; cursor: pointer; }
  .overlay img { max-width: 96vw; max-height: 96vh; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); border-radius: 4px; }
  .nav { position: fixed; top: 50%; z-index: 101; background: rgba(56,189,248,0.2); border: none; color: #fff; font-size: 32px; padding: 16px 12px; cursor: pointer; border-radius: 4px; }
  .nav:hover { background: rgba(56,189,248,0.4); }
  .nav-left { left: 8px; transform: translateY(-50%); }
  .nav-right { right: 8px; transform: translateY(-50%); }
  .counter { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 101; color: #94a3b8; font-size: 14px; background: rgba(0,0,0,0.6); padding: 4px 12px; border-radius: 4px; }
</style>
</head>
<body>
<h1>LiveSpot スクリーンショット</h1>
<p class="meta">${files.length}枚 — ${date}</p>
<div class="grid">
${files.map((f, i) => `  <div class="card" onclick="open(${i})">
    <img src="${f}" loading="lazy" />
    <div class="label">${f.replace('.png', '').replace(/^gallery-\\d+-/, '')}</div>
  </div>`).join('\n')}
</div>
<div class="overlay" id="ov" onclick="if(event.target===this)close()">
  <img id="ov-img" />
  <button class="nav nav-left" onclick="event.stopPropagation();prev()">&#8249;</button>
  <button class="nav nav-right" onclick="event.stopPropagation();next()">&#8250;</button>
  <div class="counter" id="counter"></div>
</div>
<script>
const files = ${JSON.stringify(files)};
let cur = 0;
function open(i) { cur = i; show(); }
function show() {
  document.getElementById('ov').style.display = 'block';
  document.getElementById('ov-img').src = files[cur];
  document.getElementById('counter').textContent = (cur+1) + ' / ' + files.length;
}
function close() { document.getElementById('ov').style.display = 'none'; }
function prev() { cur = (cur - 1 + files.length) % files.length; show(); }
function next() { cur = (cur + 1) % files.length; show(); }
document.addEventListener('keydown', e => {
  if (document.getElementById('ov').style.display !== 'block') return;
  if (e.key === 'Escape') close();
  if (e.key === 'ArrowLeft') prev();
  if (e.key === 'ArrowRight') next();
});
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf-8');
}
