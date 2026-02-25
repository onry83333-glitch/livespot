/**
 * playwright-auth.ts — Playwright headless Centrifugo JWT 取得
 *
 * Stripchat の WebSocket JWT はフロントエンド JS がランタイムで生成する。
 * REST API / ページ HTML では取得不可のため、headless Chrome で実際の
 * ブラウザ動作を再現し、WS 送信フレームから JWT を傍受する。
 *
 * フロー:
 *   1. Chromium起動 → Stripchatモデルページへアクセス
 *   2. Cloudflareチャレンジ対応（検出時のみ）
 *   3. 年齢確認ゲート突破（「私は18歳以上です」ボタンクリック）
 *   4. CDP Network.webSocketFrameSent で {"connect":{"token":"eyJ..."}} を傍受
 *   5. モデルオフライン時 → 配信中モデルページにフォールバック
 *   6. cf_clearance cookie をブラウザコンテキストから取得
 *   7. StripchatAuth を返却（55分 TTL）
 *
 * ゲストJWTで十分（ログイン不要）。userId は負数（ゲストID）。
 */

import { createLogger } from '../utils/logger.js';
import type { StripchatAuth } from './stripchat-auth.js';

const log = createLogger('playwright-auth');

// ----- Timeouts -----
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const JWT_WAIT_TIMEOUT_MS = 30_000;
const CF_CHALLENGE_TIMEOUT_MS = 20_000;
const ESTIMATED_TTL_SEC = 55 * 60; // 55分

interface PlaywrightAuthOptions {
  modelName?: string;
  timeoutMs?: number;
  username?: string;
  password?: string;
  headless?: boolean;
}

/**
 * Playwright で Stripchat にアクセスし、Centrifugo JWT + cf_clearance を取得。
 * Playwright 未インストール時は null を返す（フォールバックチェーン継続）。
 */
export async function fetchAuthViaPlaywright(
  options: PlaywrightAuthOptions = {},
): Promise<StripchatAuth | null> {
  const {
    modelName = 'Risa_06',
    username,
    password,
    headless = true,
  } = options;

  log.info(`[方式A] Playwright起動 (model=${modelName}, headless=${headless})`);

  // Dynamic import — Playwright 未インストールでも collector は起動可能
  let chromium: typeof import('playwright').chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    log.error('[方式A] Playwright未インストール。実行: npm install playwright && npx playwright install chromium');
    return null;
  }

  let browser: import('playwright').Browser | null = null;

  try {
    // --- 1. ブラウザ起動 ---
    browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });

    // Anti-detection: webdriver フラグ除去 (runs in browser context)
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    `);

    const page = await context.newPage();

    // --- 2. CDP で WS フレーム傍受 ---
    let capturedJwt: string | null = null;

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    // WS接続作成を監視
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cdp.on('Network.webSocketCreated', (event: any) => {
      log.info(`[方式A] WS接続検出: ${event.url}`);
    });

    // WS 送信フレームを監視 (JWT傍受)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cdp.on('Network.webSocketFrameSent', (event: any) => {
      try {
        const payload = event.response?.payloadData;
        if (!payload || typeof payload !== 'string') return;
        if (!payload.includes('"connect"') || !payload.includes('"token"')) return;

        log.debug(`[方式A] WS送信(connect検出): ${payload.substring(0, 100)}...`);

        // Centrifugoクライアントは複数コマンドを改行区切りで送る場合がある
        const lines = payload.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.includes('"connect"')) continue;
          try {
            const msg = JSON.parse(trimmed);
            const token = msg?.connect?.token;
            if (token && typeof token === 'string' && token.startsWith('eyJ')) {
              log.info(`[方式A] JWT捕捉 (${token.substring(0, 30)}...)`);
              capturedJwt = token;
              return;
            }
          } catch {
            // この行はJSON無効 → 次の行を試す
          }
        }

        // 改行区切りでなかった場合、正規表現でトークン抽出
        const tokenMatch = payload.match(/"token"\s*:\s*"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
        if (tokenMatch) {
          log.info(`[方式A] JWT捕捉(正規表現) (${tokenMatch[1].substring(0, 30)}...)`);
          capturedJwt = tokenMatch[1];
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[方式A] WS送信解析エラー: ${msg}`);
      }
    });

    // Playwright WebSocket API (補助: CDPで取りこぼした場合のバックアップ)
    page.on('websocket', ws => {
      log.debug(`[方式A] WS接続検出: ${ws.url()}`);
      ws.on('framesent', frame => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : '';
          if (!payload.includes('"connect"') || !payload.includes('"token"')) return;
          const msg = JSON.parse(payload);
          const token = msg?.connect?.token;
          if (token && typeof token === 'string' && token.startsWith('eyJ') && !capturedJwt) {
            log.info(`[方式A] JWT捕捉 (framesent) (${token.substring(0, 30)}...)`);
            capturedJwt = token;
          }
        } catch {
          // ignore
        }
      });
    });

    // --- 3. モデルページへアクセス ---
    const url = `https://stripchat.com/${encodeURIComponent(modelName)}`;
    log.info(`[方式A] ページアクセス: ${url}`);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[方式A] ページ読込: ${msg}`);
      // Cloudflareチャレンジ中やネットワーク未収束の可能性 → 続行
    }

    // --- 4. Cloudflare チャレンジ対応 ---
    const cfResolved = await handleCloudflareChallenge(page);
    if (cfResolved) {
      log.info('[方式A] Cloudflareチャレンジ解決');
    }

    // --- 5. 年齢確認ゲート + Cookie同意 突破 ---
    await dismissAgeGate(page);
    await dismissCookieConsent(page);

    // ページ状態をログ
    const pageTitle = await page.title().catch(() => '(取得失敗)');
    const pageUrl = page.url();
    log.info(`[方式A] ページ状態: title="${pageTitle}", url=${pageUrl}`);

    // デバッグ用スクリーンショット（docs/に保存）
    try {
      await page.screenshot({ path: 'docs/playwright-debug.png', fullPage: false });
      log.debug('[方式A] スクリーンショット保存: docs/playwright-debug.png');
    } catch {
      // ignore
    }

    // --- 6. ゲストJWT待機（年齢確認後、WS接続が走る） ---
    {
      const guestDeadline = Date.now() + 15_000; // 15秒待機
      while (!capturedJwt && Date.now() < guestDeadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (capturedJwt) {
        log.info('[方式A] ゲストJWT取得成功');
      }
    }

    // --- 7. モデルオフライン時のフォールバック ---
    // 対象モデルがオフラインの場合、WS接続が確立されない。
    // トップページの配信中モデルに遷移してJWTを取得する。
    if (!capturedJwt) {
      log.info('[方式A] 対象モデルでJWT未取得 — 配信中モデルで再試行...');
      const fallbackUrl = await findOnlineModelUrl(page);
      if (fallbackUrl) {
        try {
          await page.goto(fallbackUrl, {
            waitUntil: 'domcontentloaded',
            timeout: PAGE_LOAD_TIMEOUT_MS,
          });
        } catch {
          // タイムアウトでも続行
        }
        await dismissAgeGate(page);
        await dismissCookieConsent(page);

        // JWT待機
        const fallbackDeadline = Date.now() + 15_000;
        while (!capturedJwt && Date.now() < fallbackDeadline) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (capturedJwt) {
          log.info('[方式A] 配信中モデルからゲストJWT取得成功');
        }
      }
    }

    // --- 8. ゲストJWT未取得 + 認証情報あり → ログイン ---
    if (!capturedJwt && username && password) {
      log.info('[方式A] ゲストJWT未取得、ログイン試行...');
      await performLogin(page, username, password);

      // ログイン後、モデルページに再アクセス
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_LOAD_TIMEOUT_MS,
        });
      } catch {
        // タイムアウトでも続行
      }

      // ログイン後も年齢確認ゲートが出る可能性
      await dismissAgeGate(page);
    }

    // --- 9. JWT 最終待機 ---
    if (!capturedJwt) {
      const deadline = Date.now() + JWT_WAIT_TIMEOUT_MS;
      while (!capturedJwt && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (!capturedJwt) {
      log.warn('[方式A] JWT取得タイムアウト — Centrifugo WS接続が確立されなかった');

      // フォールバック: ページ内スクリプトからトークン検索
      capturedJwt = await searchPageForToken(page);
    }

    if (!capturedJwt) {
      log.error('[方式A] JWT取得失敗');
      return null;
    }

    // --- 10. Cookie 取得 ---
    const cookies = await context.cookies('https://stripchat.com');
    const cfClearance = cookies.find(c => c.name === 'cf_clearance')?.value || '';

    if (cfClearance) {
      log.info(`[方式A] cf_clearance取得 (${cfClearance.substring(0, 20)}...)`);
    } else {
      log.warn('[方式A] cf_clearance cookie未検出');
    }

    // --- 11. JWT からユーザーID抽出 ---
    const userId = extractUserIdFromJwt(capturedJwt);

    const auth: StripchatAuth = {
      jwt: capturedJwt,
      cfClearance,
      wsUrl: 'wss://websocket-sp-v6.stripchat.com/connection/websocket',
      userId,
      expiresAt: Math.floor(Date.now() / 1000) + ESTIMATED_TTL_SEC,
      method: 'playwright',
    };

    log.info(`[方式A] 認証取得完了 (userId=${userId}, expires=${new Date(auth.expiresAt * 1000).toLocaleTimeString('ja-JP')})`);
    return auth;

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[方式A] 致命的エラー: ${msg}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
        log.debug('[方式A] ブラウザ終了');
      } catch (closeErr: unknown) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        log.warn(`[方式A] ブラウザ終了エラー: ${msg}`);
      }
    }
  }
}

// ----- 配信中モデルURL取得（オフライン時フォールバック）-----

async function findOnlineModelUrl(
  page: import('playwright').Page,
): Promise<string | null> {
  try {
    // Stripchat API で配信中モデルを1件取得
    const modelUrl = await page.evaluate(`(async () => {
      try {
        var resp = await fetch('/api/front/v2/models?limit=1&primaryTag=girls&sortBy=viewers&offset=0');
        var data = await resp.json();
        var blocks = data.blocks || [];
        for (var block of blocks) {
          var models = block.models || [];
          for (var m of models) {
            if (m.isLive && m.username) {
              return '/' + m.username;
            }
          }
        }
      } catch(e) {}
      return null;
    })()`);

    if (modelUrl && typeof modelUrl === 'string') {
      const fullUrl = `https://stripchat.com${modelUrl}`;
      log.info(`[方式A] 配信中モデル検出: ${fullUrl}`);
      return fullUrl;
    }

    // APIが使えなかった場合、ページ内のリンクから検索
    const linkUrl = await page.evaluate(`(() => {
      var links = document.querySelectorAll('a[href*="/model/"] , a[data-model-username]');
      for (var l of links) {
        var href = l.getAttribute('href') || '';
        if (href && !href.includes('/login') && !href.includes('/signup')) {
          return href;
        }
      }
      return null;
    })()`);

    if (linkUrl && typeof linkUrl === 'string') {
      const fullUrl = linkUrl.startsWith('http') ? linkUrl : `https://stripchat.com${linkUrl}`;
      log.info(`[方式A] ページ内リンクからモデル検出: ${fullUrl}`);
      return fullUrl;
    }

    log.warn('[方式A] 配信中モデル検出失敗');
    return null;
  } catch {
    return null;
  }
}

// ----- Cookie同意バナー突破 -----

async function dismissCookieConsent(
  page: import('playwright').Page,
): Promise<void> {
  try {
    const dismissed = await page.evaluate(`(() => {
      // "すべて受信" / "Accept All" ボタンを探す
      var buttons = document.querySelectorAll('button');
      for (var b of buttons) {
        var text = (b.textContent || '').trim();
        if (text.includes('すべて受') || text.includes('Accept') || text.includes('同意')) {
          b.click();
          return true;
        }
      }
      return false;
    })()`);
    if (dismissed) {
      log.debug('[方式A] Cookie同意バナー突破');
    }
  } catch {
    // ignore
  }
}

// ----- 年齢確認ゲート突破 -----

async function dismissAgeGate(
  page: import('playwright').Page,
): Promise<boolean> {
  try {
    // Stripchat の年齢確認ボタン: "私は18歳以上です" / "I am 18 or older"
    // ボタンのテキスト内容で検索（ロケール依存しない複数パターン）
    const clicked = await page.evaluate(`(() => {
      // パターン1: テキスト内容で検索
      var buttons = document.querySelectorAll('button, a[role="button"], [class*="btn"]');
      for (var b of buttons) {
        var text = (b.textContent || '').trim();
        if (text.includes('18') && (text.includes('歳') || text.includes('older') || text.includes('above') || text.includes('enter'))) {
          b.click();
          return 'text';
        }
      }
      // パターン2: data属性やid
      var gate = document.querySelector('[data-testid="age-gate-accept"], #age-gate-accept, .age-verification-accept');
      if (gate) { gate.click(); return 'selector'; }
      // パターン3: 大きなリンクボタン（Stripchat標準レイアウト）
      var links = document.querySelectorAll('a');
      for (var a of links) {
        var t = (a.textContent || '').trim();
        if (t.includes('18') && t.length < 50) { a.click(); return 'link'; }
      }
      return null;
    })()`);

    if (clicked) {
      log.info(`[方式A] 年齢確認ゲート突破 (method=${clicked})`);
      // ページ遷移/リロード待ち
      await page.waitForTimeout(3000);
      // networkidle を待って、JS初期化+WS接続の開始を待つ
      try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 });
      } catch {
        // タイムアウトでも続行
      }
      return true;
    }

    log.debug('[方式A] 年齢確認ゲート未検出（不要またはログイン済み）');
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug(`[方式A] 年齢確認ゲート処理スキップ: ${msg}`);
    return false;
  }
}

// ----- Cloudflare チャレンジハンドラ -----

async function handleCloudflareChallenge(
  page: import('playwright').Page,
): Promise<boolean> {
  try {
    // page.evaluate runs in browser context (DOM available)
    const isCfChallenge = await page.evaluate(`
      document.title.includes('Just a moment') ||
      document.querySelector('#challenge-running') !== null ||
      document.querySelector('.cf-browser-verification') !== null
    `);

    if (!isCfChallenge) return false;

    log.info('[方式A] Cloudflareチャレンジ検出、待機中...');

    await page.waitForFunction(
      `!document.title.includes('Just a moment')`,
      { timeout: CF_CHALLENGE_TIMEOUT_MS },
    );

    // ページ安定化待ち
    await page.waitForTimeout(2000);
    return true;
  } catch {
    log.warn('[方式A] Cloudflareチャレンジ解決タイムアウト');
    return false;
  }
}

// ----- ログインフロー -----

async function performLogin(
  page: import('playwright').Page,
  username: string,
  password: string,
): Promise<void> {
  try {
    // ログインページへ遷移
    log.info('[方式A] ログインページへ遷移...');
    await page.goto('https://stripchat.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    // 年齢確認ゲートがログインページにも出る場合
    await dismissAgeGate(page);

    // スクリーンショット（デバッグ用）
    try {
      await page.screenshot({ path: 'docs/playwright-login.png' });
    } catch { /* ignore */ }

    // ログインフォーム入力（複数セレクタでフォールバック）
    const loginSelectors = [
      'input[name="login"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[type="text"][autocomplete="username"]',
      'input[type="text"]',
    ];
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
    ];
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button[class*="login"]',
      'button[class*="submit"]',
    ];

    let filled = false;
    for (const sel of loginSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(username);
          log.debug(`[方式A] ユーザー名入力: ${sel}`);
          filled = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!filled) {
      log.warn('[方式A] ユーザー名フィールド未検出');
      return;
    }

    filled = false;
    for (const sel of passwordSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.fill(password);
          log.debug(`[方式A] パスワード入力: ${sel}`);
          filled = true;
          break;
        }
      } catch { /* try next */ }
    }
    if (!filled) {
      log.warn('[方式A] パスワードフィールド未検出');
      return;
    }

    // 送信
    for (const sel of submitSelectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          log.info(`[方式A] ログインボタンクリック: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    // ナビゲーション or ページ変化を待機
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch {
      // SPA遷移の場合 waitForNavigation がタイムアウトしうる
      await page.waitForTimeout(3000);
    }

    const afterLoginUrl = page.url();
    log.info(`[方式A] ログイン送信完了 (url=${afterLoginUrl})`);

    // ログイン後スクリーンショット
    try {
      await page.screenshot({ path: 'docs/playwright-after-login.png' });
    } catch { /* ignore */ }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[方式A] ログイン失敗: ${msg}`);
    // 失敗時スクリーンショット
    try {
      await page.screenshot({ path: 'docs/playwright-login-error.png' });
    } catch { /* ignore */ }
  }
}

// ----- ページ内スクリプトからトークン検索（フォールバック）-----

async function searchPageForToken(
  page: import('playwright').Page,
): Promise<string | null> {
  try {
    // page.evaluate runs in browser context (DOM/window available)
    const token = await page.evaluate(`(() => {
      var scripts = document.querySelectorAll('script');
      for (var s of scripts) {
        var match = s.textContent && s.textContent.match(/"token"\\s*:\\s*"(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)"/);
        if (match) return match[1];
      }
      return window.__CONFIG__ && window.__CONFIG__.wsToken
        || window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.config && window.__PRELOADED_STATE__.config.centrifugoToken
        || window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.centrifugoToken
        || null;
    })()`) as string | null;

    if (token) {
      log.info(`[方式A] ページ内スクリプトからJWT検出 (${token.substring(0, 30)}...)`);
    }
    return token;
  } catch {
    return null;
  }
}

// ----- JWT ペイロードデコード -----

function extractUserIdFromJwt(jwt: string): string {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return String(payload?.sub || payload?.info?.userId || '');
  } catch {
    return '';
  }
}
