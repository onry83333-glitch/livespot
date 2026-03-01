/**
 * Strip Live Spot - Popup Script (Auth Exporter)
 *
 * Login, account select, cast identity detection only.
 * コイン同期・DM送信はサーバーサイドに移行済み。
 */

// 環境判定: CWS経由インストール=本番、それ以外=開発
const _isProd = 'update_url' in (chrome.runtime.getManifest() || {});
const DEFAULT_API_URL = _isProd
  ? 'https://livespot-api.onrender.com'
  : 'http://localhost:8000';
const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NjQ5NzcsImV4cCI6MjA4NjU0MDk3N30._vllLuXCU34JMbh0HTM6vIlglGRBX2oP7KBz_5XfKeo';

// ============================================================
// DOM Elements
// ============================================================
const $ = (id) => document.getElementById(id);
const statusDot = $('statusDot');
const statusText = $('statusText');
const loginSection = $('loginSection');
const dashboardSection = $('dashboardSection');
const emailInput = $('emailInput');
const passwordInput = $('passwordInput');
const loginBtn = $('loginBtn');
const loginError = $('loginError');
const accountSelect = $('accountSelect');

// ============================================================
// Supabase Auth via REST API
// ============================================================
async function supabaseLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || 'ログインに失敗しました');
  }

  return res.json();
}

// ============================================================
// Token Refresh
// ============================================================
async function refreshSupabaseToken() {
  const data = await chrome.storage.local.get(['refresh_token']);
  if (!data.refresh_token) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: data.refresh_token }),
    });
    if (!res.ok) return false;
    const result = await res.json();
    await chrome.storage.local.set({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    chrome.runtime.sendMessage({
      type: 'AUTH_UPDATED',
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    return true;
  } catch (e) {
    console.error('[LSP] Token refresh error:', e.message);
    return false;
  }
}

// ============================================================
// Token Helpers
// ============================================================
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // 30秒のマージンを持たせる
    return payload.exp * 1000 < Date.now() + 30000;
  } catch {
    return true;
  }
}

async function forceLogout() {
  await chrome.storage.local.remove([
    'access_token', 'refresh_token', 'logged_in', 'user_email', 'user_id',
  ]);
  showLogin();
}

// ============================================================
// UI State
// ============================================================
function showLogin() {
  loginSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = '未接続';
}

function showDashboard() {
  loginSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');
  statusDot.className = 'status-dot connected';
  statusText.textContent = '接続中';
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.add('show');
}

function hideError() {
  loginError.classList.remove('show');
}

// ============================================================
// Cast Identity Detection
// ============================================================
async function detectLoggedInCast() {
  const section = $('castIdentitySection');
  const icon = $('castIdentityIcon');
  const text = $('castIdentityText');
  const clearBtn = $('clearCookiesBtn');
  if (!section) return;

  section.style.display = 'flex';
  section.className = 'cast-identity unknown';
  text.textContent = '検出中...';
  clearBtn.style.display = 'none';

  chrome.runtime.sendMessage({ type: 'GET_LOGGED_IN_CAST' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      section.className = 'cast-identity unknown';
      icon.innerHTML = '&#9679;';
      text.textContent = 'キャスト検出不可';
      return;
    }

    // 複数userId検出: 即座に警告（DM送信不可状態）
    if (response.multipleDetected) {
      section.className = 'cast-identity warning';
      icon.innerHTML = '&#9888;';
      text.innerHTML = `<strong>複数アカウント検出!</strong><br>` +
        `<span style="font-size:10px;">ID: ${(response.allUserIds || []).join(', ')}<br>` +
        `「リセット」を押してcookieをクリアし、正しいキャストで再ログインしてください。<br>` +
        `<strong>この状態ではDM送信はブロックされます。</strong></span>`;
      clearBtn.style.display = 'block';
      return;
    }

    if (!response.userId) {
      section.className = 'cast-identity unknown';
      icon.innerHTML = '&#9679;';
      text.textContent = 'Stripchat未ログイン';
      return;
    }

    if (response.castName) {
      // 既知のキャストにログイン中
      section.className = 'cast-identity ok';
      icon.innerHTML = '&#9679;';
      text.innerHTML = `ログイン中: <span class="cast-identity-name">${response.displayName || response.castName}</span>`;
      clearBtn.style.display = 'block';
    } else {
      // ログインしているがキャストが不明（未登録のstripchat_user_id）
      section.className = 'cast-identity warning';
      icon.innerHTML = '&#9888;';
      text.innerHTML = `不明なアカウント (ID: ${response.userId})`;
      clearBtn.style.display = 'block';

      // 登録済みキャストがある場合、誤送信の危険を表示
      if (response.allCasts && response.allCasts.length > 0) {
        const expected = response.allCasts.map(c => c.cast_name).join(', ');
        text.innerHTML += `<br><span style="font-size:10px;">登録済み: ${expected}</span>`;
      }
    }
  });
}

// ============================================================
// Data Loading
// ============================================================

/**
 * 最新のアクセストークンを取得（期限切れなら自動リフレッシュ）
 * @returns {string|null} 有効なトークン、または null（認証切れ）
 */
async function getValidToken() {
  const data = await chrome.storage.local.get(['access_token', 'refresh_token']);
  if (!data.access_token && !data.refresh_token) return null;

  let token = data.access_token;
  if (!token || isTokenExpired(token)) {
    if (!data.refresh_token) return null;
    const refreshed = await refreshSupabaseToken();
    if (!refreshed) return null;
    const d2 = await chrome.storage.local.get(['access_token']);
    token = d2.access_token;
  }
  return token;
}

/**
 * Supabase REST API に認証付きfetchを実行（401時は自動リフレッシュ+リトライ）
 * @returns {Response|null} レスポンス、または null（認証切れ）
 */
async function supabaseFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (res.ok) return res;

  // 401: トークンリフレッシュ+リトライ
  if (res.status === 401) {
    const refreshed = await refreshSupabaseToken();
    if (!refreshed) return null; // 認証切れ
    const d2 = await chrome.storage.local.get(['access_token']);
    const retry = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${d2.access_token}`,
      },
    });
    if (retry.ok) return retry;
    if (retry.status === 401) return null; // 認証切れ
    console.warn('[LSP] API retry failed:', retry.status, url);
    return retry; // 非認証エラー
  }

  console.warn('[LSP] API error:', res.status, url);
  return res; // 非認証エラー（呼び元で判定）
}

async function fetchAccountsFromSupabase() {
  const token = await getValidToken();
  if (!token) return null; // null = 認証切れ

  try {
    const res = await supabaseFetch(
      `${SUPABASE_URL}/rest/v1/accounts?select=id,account_name`,
      token,
    );
    if (!res) return null; // 認証切れ
    if (!res.ok) {
      console.error('[LSP] Accounts HTTP error:', res.status);
      return [];
    }
    return res.json();
  } catch (e) {
    console.error('[LSP] Accounts fetch error:', e.message);
    return [];
  }
}

async function loadAccounts() {
  const accounts = await fetchAccountsFromSupabase();

  // null = 認証切れ → ログイン画面に戻す
  if (accounts === null) {
    await forceLogout();
    return;
  }

  if (accounts.length === 0) {
    // データが空の場合 — 認証トークンが無効な可能性が高い
    // リフレッシュを再試行して1回だけリトライ
    console.warn('[LSP] Accounts empty — retrying with fresh token...');
    const refreshed = await refreshSupabaseToken();
    if (refreshed) {
      const retryAccounts = await fetchAccountsFromSupabase();
      if (retryAccounts && retryAccounts.length > 0) {
        await populateAccounts(retryAccounts);
        return;
      }
    }
    accountSelect.innerHTML = '<option value="">アカウントなし — 再ログインしてください</option>';
    return;
  }

  await populateAccounts(accounts);
}

async function populateAccounts(accounts) {
  accountSelect.innerHTML = '<option value="">選択してください</option>';
  accounts.forEach((acc) => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = acc.account_name || acc.id;
    accountSelect.appendChild(opt);
  });

  const data = await chrome.storage.local.get(['account_id']);
  if (data.account_id) {
    accountSelect.value = data.account_id;
  } else if (accounts.length === 1) {
    accountSelect.value = accounts[0].id;
    await chrome.storage.local.set({ account_id: accounts[0].id });
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', account_id: accounts[0].id });
  }
}

// ============================================================
// Initialize
// ============================================================
async function init() {
  const data = await chrome.storage.local.get([
    'access_token', 'refresh_token', 'logged_in', 'account_id',
  ]);

  if (data.access_token || data.logged_in) {
    // 常にトークンリフレッシュを試行（サーバー側で無効化されたトークン対策）
    if (data.refresh_token) {
      const refreshed = await refreshSupabaseToken();
      if (!refreshed && !data.access_token) {
        // リフレッシュ失敗 + アクセストークンもなし → ログイン画面
        await forceLogout();
        return;
      }
      // リフレッシュ失敗でもアクセストークンがあれば試行続行
    } else if (!data.access_token) {
      await forceLogout();
      return;
    }

    showDashboard();
    await loadAccounts();
    detectLoggedInCast();
  } else {
    showLogin();
  }
}

// ============================================================
// Event Handlers
// ============================================================

// --- Login ---
loginBtn.addEventListener('click', async () => {
  hideError();
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('メールアドレスとパスワードを入力してください');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '認証中...';

  try {
    const result = await supabaseLogin(email, password);

    await chrome.storage.local.set({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      user_email: result.user?.email,
      user_id: result.user?.id,
      logged_in: true,
    });

    chrome.runtime.sendMessage({
      type: 'AUTH_UPDATED',
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });

    showDashboard();
    await loadAccounts();
    detectLoggedInCast();
  } catch (err) {
    const msg = err.message === 'Invalid login credentials'
      ? 'メールアドレスまたはパスワードが正しくありません'
      : err.message;
    showError(msg);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'ログイン';
  }
});

passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

// --- Account Selection ---
accountSelect.addEventListener('change', async () => {
  const id = accountSelect.value;
  if (id) {
    chrome.storage.local.set({ account_id: id });
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', account_id: id });
    // アカウント切り替え時にAMP cookieを自動クリーンアップ（誤送信防止）
    chrome.runtime.sendMessage({ type: 'CLEAR_CAST_COOKIES' }, (response) => {
      if (response && response.ok) {
        console.log('[LSP] アカウント切替: AMP cookie', response.cleared, '件クリア');
      }
      // クリーンアップ後にキャスト身元を再検出
      setTimeout(detectLoggedInCast, 500);
    });
  }
});

// --- Clear Cast Cookies ---
$('clearCookiesBtn').addEventListener('click', () => {
  const btn = $('clearCookiesBtn');
  btn.disabled = true;
  btn.textContent = '削除中...';

  chrome.runtime.sendMessage({ type: 'CLEAR_CAST_COOKIES' }, (response) => {
    btn.disabled = false;
    btn.textContent = 'リセット';

    if (chrome.runtime.lastError) {
      console.error('[LSP] Cookie clear error:', chrome.runtime.lastError.message);
      return;
    }

    if (response && response.ok) {
      const section = $('castIdentitySection');
      section.className = 'cast-identity unknown';
      $('castIdentityIcon').innerHTML = '&#9679;';
      $('castIdentityText').textContent = `Cookie削除完了 (${response.cleared}件)。ブラウザで再ログインしてください。`;
      btn.style.display = 'none';
    }
  });
});

// --- Account Selection Change → Re-detect cast ---
// (also triggers on page load if account was pre-selected)

// --- Logout ---
$('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await forceLogout();
});

// --- Start ---
init();
