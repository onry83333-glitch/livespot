/**
 * Strip Live Spot - Popup Script (Simplified)
 *
 * Streamlined to: login, account select, coin sync only.
 * Background processes (SPY, AutoPatrol, rotation, STT) continue independently.
 */

// 環境判定: CWS経由インストール=本番、それ以外=開発
const _isProd = 'update_url' in (chrome.runtime.getManifest() || {});
const DEFAULT_API_URL = _isProd
  ? 'https://livespot-api.onrender.com'
  : 'http://localhost:8000';
const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ';

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
const coinSyncCastSelect = $('coinSyncCastSelect');

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
async function fetchAccountsFromSupabase() {
  const data = await chrome.storage.local.get(['access_token']);
  if (!data.access_token) return null; // null = 認証切れ

  // トークン期限切れなら先にリフレッシュ
  let token = data.access_token;
  if (isTokenExpired(token)) {
    const refreshed = await refreshSupabaseToken();
    if (!refreshed) return null; // null = 認証切れ
    const d2 = await chrome.storage.local.get(['access_token']);
    token = d2.access_token;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      if (res.status === 401) {
        // リフレッシュ再試行
        const refreshed = await refreshSupabaseToken();
        if (refreshed) {
          const d2 = await chrome.storage.local.get(['access_token']);
          const retry = await fetch(`${SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
            headers: {
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${d2.access_token}`,
            },
          });
          if (retry.ok) return retry.json();
        }
        return null; // null = 認証切れ
      }
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

  if (accounts.length === 0) {
    accountSelect.innerHTML = '<option value="">アカウントなし</option>';
  }
}

async function loadCastsForSync() {
  const data = await chrome.storage.local.get(['access_token', 'account_id']);
  if (!data.access_token || !data.account_id) {
    coinSyncCastSelect.innerHTML = '<option value="">アカウント未選択</option>';
    return;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${data.account_id}&is_active=eq.true&select=cast_name,display_name`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${data.access_token}`,
        },
      }
    );
    if (!res.ok) {
      coinSyncCastSelect.innerHTML = '<option value="">取得失敗</option>';
      return;
    }
    const casts = await res.json();
    coinSyncCastSelect.innerHTML = '<option value="">キャストを選択</option>';
    casts.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.cast_name;
      opt.textContent = c.display_name || c.cast_name;
      coinSyncCastSelect.appendChild(opt);
    });
    const saved = await chrome.storage.local.get(['last_sync_cast_name']);
    if (saved.last_sync_cast_name) {
      coinSyncCastSelect.value = saved.last_sync_cast_name;
    }
    if (casts.length === 1) {
      coinSyncCastSelect.value = casts[0].cast_name;
      await chrome.storage.local.set({ last_sync_cast_name: casts[0].cast_name });
    }
  } catch (e) {
    console.error('[LSP] Casts fetch error:', e.message);
    coinSyncCastSelect.innerHTML = '<option value="">エラー</option>';
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
    // トークンが無い or 期限切れ → リフレッシュ試行
    const needsRefresh = !data.access_token || isTokenExpired(data.access_token);
    if (needsRefresh && data.refresh_token) {
      const refreshed = await refreshSupabaseToken();
      if (!refreshed) {
        await forceLogout();
        return;
      }
    } else if (needsRefresh && !data.refresh_token) {
      await forceLogout();
      return;
    }

    showDashboard();
    loadAccounts();
    loadCastsForSync();
    detectLoggedInCast();

    // Restore last coin sync status
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.ok && response.lastCoinSync) {
        const syncEl = $('coinSyncStatus');
        if (syncEl) {
          const syncDate = new Date(response.lastCoinSync).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          syncEl.innerHTML = `<span style="color:#475569;">前回: ${syncDate} (${response.coinSyncCount || 0}件)</span>`;
          syncEl.classList.remove('hidden');
        }
      }
    });
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
    loadCastsForSync();
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
accountSelect.addEventListener('change', () => {
  const id = accountSelect.value;
  if (id) {
    chrome.storage.local.set({ account_id: id });
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', account_id: id });
    loadCastsForSync();
    // アカウント切り替え時にキャスト身元を再検出
    setTimeout(detectLoggedInCast, 500);
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

// --- Coin Sync Cast Selection ---
coinSyncCastSelect.addEventListener('change', () => {
  const castName = coinSyncCastSelect.value;
  if (castName) {
    chrome.storage.local.set({ last_sync_cast_name: castName });
  }
});

// --- Coin Sync ---
$('coinSyncBtn').addEventListener('click', async () => {
  const btn = $('coinSyncBtn');
  const statusEl = $('coinSyncStatus');

  const selectedCast = coinSyncCastSelect.value;
  if (!selectedCast) {
    statusEl.innerHTML = '<span style="color:#f43f5e;">キャストを選択してください</span>';
    statusEl.classList.remove('hidden');
    return;
  }

  await chrome.storage.local.set({ last_sync_cast_name: selectedCast });

  btn.disabled = true;
  btn.textContent = '同期中...';
  statusEl.innerHTML = '<span style="color:#f59e0b;">● 取得中...</span>';
  statusEl.classList.remove('hidden');

  chrome.runtime.sendMessage({ type: 'SYNC_COINS' }, (response) => {
    btn.disabled = false;
    btn.textContent = '同期';

    if (chrome.runtime.lastError) {
      statusEl.innerHTML = `<span style="color:#f43f5e;">✕ 通信エラー: ${chrome.runtime.lastError.message}</span>`;
      return;
    }

    if (!response) {
      statusEl.innerHTML = '<span style="color:#f43f5e;">✕ 応答なし</span>';
      return;
    }

    if (response.ok) {
      const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      statusEl.innerHTML = `<span style="color:#22c55e;">✓ ${response.message || response.synced + '件同期'}</span>`
        + `<br><span style="color:#475569;">最終同期: ${now}</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:#f43f5e;">✕ ${response.error || 'エラー'}</span>`;
    }
  });
});

// --- Logout ---
$('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await forceLogout();
});

// --- Start ---
init();
