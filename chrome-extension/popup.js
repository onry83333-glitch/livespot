/**
 * Strip Live Spot - Popup Script
 * Supabase REST API認証、設定管理、ステータス表示
 * 状態は chrome.storage.local に永続化し、ポップアップ再開時に復元
 */

const DEFAULT_API_URL = 'http://localhost:8000';
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
const dmQueueCount = $('dmQueueCount');
const spyMsgCount = $('spyMsgCount');
const spyToggleBtn = $('spyToggleBtn');
const apiUrlInput = $('apiUrlInput');
const apiUrlInputLogin = $('apiUrlInputLogin');
const saveSettingsBtn = $('saveSettingsBtn');
const saveSettingsBtnLogin = $('saveSettingsBtnLogin');
const logoutBtn = $('logoutBtn');

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
// Token Refresh（ポップアップ再開時にトークン切れを自動復旧）
// ============================================================
async function refreshSupabaseToken() {
  const data = await chrome.storage.local.get(['refresh_token']);
  if (!data.refresh_token) {
    console.log('[LSP] トークンリフレッシュ: refresh_tokenなし、スキップ');
    return false;
  }
  try {
    console.log('[LSP] トークンリフレッシュ: 実行中...');
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: data.refresh_token }),
    });
    if (!res.ok) {
      console.warn('[LSP] トークンリフレッシュ: 失敗 status=', res.status);
      return false;
    }
    const result = await res.json();
    await chrome.storage.local.set({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    // backgroundに即座に通知
    chrome.runtime.sendMessage({
      type: 'AUTH_UPDATED',
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    console.log('[LSP] トークンリフレッシュ: 成功 → AUTH_UPDATED送信');
    return true;
  } catch (e) {
    console.error('[LSP] トークンリフレッシュ: エラー', e.message);
    return false;
  }
}

// ============================================================
// UI State
// ============================================================
function showLogin() {
  console.log('[LSP] UI切替: ログイン画面表示');
  loginSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');
  statusDot.className = 'status-dot disconnected';
  statusText.textContent = '未接続';
}

function showDashboard() {
  console.log('[LSP] UI切替: ダッシュボード表示');
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

function flashSaveSuccess(el) {
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ============================================================
// Data Loading — Supabase REST API直接クエリ（バックエンド不要）
// ============================================================
async function fetchAccountsFromSupabase() {
  const data = await chrome.storage.local.get(['access_token']);
  if (!data.access_token) {
    console.warn('[LSP] Supabase accounts取得: access_tokenなし');
    return [];
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${data.access_token}`,
      },
    });
    if (!res.ok) {
      console.warn('[LSP] Supabase accounts取得失敗: status=', res.status);
      // 401ならトークンリフレッシュ後にリトライ
      if (res.status === 401) {
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
      }
      return [];
    }
    return res.json();
  } catch (e) {
    console.error('[LSP] Supabase accounts取得エラー:', e.message);
    return [];
  }
}

async function loadAccounts() {
  const accounts = await fetchAccountsFromSupabase();
  console.log('[LSP] アカウント取得:', accounts.length, '件');

  accountSelect.innerHTML = '<option value="">選択してください</option>';
  accounts.forEach((acc) => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = acc.account_name || acc.id;
    accountSelect.appendChild(opt);
  });

  // 保存済みアカウントを復元
  const data = await chrome.storage.local.get(['account_id']);
  if (data.account_id) {
    accountSelect.value = data.account_id;
    console.log('[LSP] アカウント復元:', data.account_id);
  } else if (accounts.length === 1) {
    // 1つだけなら自動選択 → storage + background に通知
    accountSelect.value = accounts[0].id;
    await chrome.storage.local.set({ account_id: accounts[0].id });
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', account_id: accounts[0].id });
    console.log('[LSP] アカウント自動選択:', accounts[0].id, accounts[0].account_name);
  }

  if (accounts.length === 0) {
    accountSelect.innerHTML = '<option value="">アカウントなし</option>';
  }
}

function loadDMQueueCount() {
  chrome.runtime.sendMessage({ type: 'GET_DM_QUEUE' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.ok && Array.isArray(response.data)) {
      dmQueueCount.textContent = response.data.length;
    } else {
      dmQueueCount.textContent = '0';
    }
  });
}

function updateSpyButton(enabled) {
  console.log('[LSP] SPYボタン更新: enabled=', enabled);
  if (enabled) {
    spyToggleBtn.textContent = '監視停止';
    spyToggleBtn.classList.add('active');
  } else {
    spyToggleBtn.textContent = '監視開始';
    spyToggleBtn.classList.remove('active');
  }
}

function updateSTTButton(enabled) {
  const btn = $('sttToggleBtn');
  const info = $('sttStatusInfo');
  if (!btn) return;
  if (enabled) {
    btn.textContent = '停止';
    btn.style.background = 'linear-gradient(135deg, #f43f5e, #e11d48)';
    if (info) {
      info.innerHTML = '<span style="color:#a78bfa;">● 文字起こし中</span>';
      info.classList.remove('hidden');
    }
  } else {
    btn.textContent = '開始';
    btn.style.background = 'linear-gradient(135deg, #a78bfa, #7c3aed)';
    if (info) {
      info.innerHTML = '';
      info.classList.add('hidden');
    }
  }
}

let spyElapsedTimer = null;

function updateRecIndicator(active, castName) {
  const recEl = $('recIndicator');
  const recCast = $('recCastName');
  if (!recEl) return;
  if (active) {
    recEl.classList.add('active');
    if (recCast) recCast.textContent = castName ? `— ${castName}` : '';
  } else {
    recEl.classList.remove('active');
  }
}

function updateSpyInfo(active, castName, startedAt) {
  const infoEl = $('spyStatusInfo');
  if (!infoEl) return;
  updateRecIndicator(active, castName);
  if (spyElapsedTimer) {
    clearInterval(spyElapsedTimer);
    spyElapsedTimer = null;
  }
  console.log('[LSP] SPY情報更新: active=', active, 'cast=', castName, 'started=', startedAt);

  if (active) {
    // startedAt がなくても「監視中」は表示する
    if (startedAt) {
      const updateElapsed = () => {
        const elapsed = Date.now() - new Date(startedAt).getTime();
        const h = Math.floor(elapsed / 3600000);
        const m = Math.floor((elapsed % 3600000) / 60000);
        const s = Math.floor((elapsed % 60000) / 1000);
        const timeStr = h > 0 ? `${h}時間${m}分` : `${m}分${s}秒`;
        infoEl.innerHTML = `<span style="color:#22c55e;">● 監視中</span> ${castName || '—'} <span style="color:#475569;">${timeStr}</span>`;
      };
      updateElapsed();
      spyElapsedTimer = setInterval(updateElapsed, 1000);
    } else {
      infoEl.innerHTML = `<span style="color:#22c55e;">● 監視中</span> ${castName || ''}`;
    }
    infoEl.classList.remove('hidden');
  } else {
    infoEl.innerHTML = '';
    infoEl.classList.add('hidden');
  }
}

// ============================================================
// SPY受信カウントをbackgroundから取得
// ============================================================
function loadSpyMsgCount() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.ok) {
      spyMsgCount.textContent = response.spyMsgCount || '0';
    }
  });
}

// ============================================================
// Initialize
// ============================================================
async function init() {
  console.log('[LSP] === ポップアップ初期化開始 ===');

  const data = await chrome.storage.local.get([
    'access_token', 'refresh_token', 'logged_in', 'account_id',
    'api_base_url', 'spy_enabled', 'spy_cast', 'spy_started_at', 'stt_enabled',
  ]);

  console.log('[LSP] Storage読込結果:', JSON.stringify({
    has_access_token: !!data.access_token,
    has_refresh_token: !!data.refresh_token,
    logged_in: data.logged_in,
    account_id: data.account_id || null,
    spy_enabled: data.spy_enabled,
    spy_cast: data.spy_cast || null,
    spy_started_at: data.spy_started_at || null,
  }));

  const apiUrl = data.api_base_url || DEFAULT_API_URL;
  apiUrlInput.value = apiUrl;
  apiUrlInputLogin.value = apiUrl;

  if (data.access_token || data.logged_in) {
    // access_token が消えていても refresh_token があれば復旧
    if (!data.access_token && data.refresh_token) {
      console.log('[LSP] access_tokenなし → リフレッシュ試行');
      const refreshed = await refreshSupabaseToken();
      if (!refreshed) {
        console.warn('[LSP] リフレッシュ失敗 → ログイン画面へ');
        await chrome.storage.local.remove(['logged_in']);
        showLogin();
        return;
      }
    }

    showDashboard();
    loadAccounts();
    loadDMQueueCount();
    loadSpyMsgCount();

    // SPY状態の復元: storageから読んだ値で即座にUI更新
    const spyActive = data.spy_enabled === true;
    console.log('[LSP] SPY状態復元: spy_enabled=', spyActive);
    updateSpyButton(spyActive);
    updateSpyInfo(spyActive, data.spy_cast, data.spy_started_at);

    // STT状態の復元
    updateSTTButton(data.stt_enabled === true);

    // さらにbackgroundに最新状態を問い合わせて補正
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[LSP] GET_STATUS失敗:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.ok) {
        console.log('[LSP] Background状態:', JSON.stringify({
          spyEnabled: response.spyEnabled,
          spyMsgCount: response.spyMsgCount,
          bufferSize: response.bufferSize,
          lastHeartbeat: response.lastHeartbeat,
        }));
        // backgroundの状態がstorageと異なる場合、backgroundを信頼
        if (response.spyEnabled !== spyActive) {
          console.log('[LSP] SPY状態不一致 → background側を採用: ', response.spyEnabled);
          updateSpyButton(response.spyEnabled);
          updateSpyInfo(response.spyEnabled, data.spy_cast, data.spy_started_at);
        }
        spyMsgCount.textContent = response.spyMsgCount || '0';
        // STT状態も同期
        if (response.sttEnabled !== undefined) {
          updateSTTButton(response.sttEnabled);
        }
        // Coin同期ステータス表示
        if (response.lastCoinSync) {
          const syncEl = $('coinSyncStatus');
          if (syncEl) {
            const syncDate = new Date(response.lastCoinSync).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            syncEl.innerHTML = `<span style="color:#475569;">前回: ${syncDate} (${response.coinSyncCount || 0}件)</span>`;
            syncEl.classList.remove('hidden');
          }
        }
      }
    });
  } else {
    console.log('[LSP] 認証情報なし → ログイン画面');
    showLogin();
  }

  console.log('[LSP] === ポップアップ初期化完了 ===');
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
    console.log('[LSP] ログイン試行: ', email);
    const result = await supabaseLogin(email, password);

    const tokenPreview = result.access_token ? result.access_token.substring(0, 20) + '...' : 'null';
    console.log('[LSP] ログイン成功 access_token保存:', tokenPreview);

    await chrome.storage.local.set({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      user_email: result.user?.email,
      user_id: result.user?.id,
      logged_in: true,
    });
    console.log('[LSP] ログイン成功: storage保存完了 user_id=', result.user?.id);

    // backgroundに即座にauth情報を通知（storage.onChanged待ちを回避）
    chrome.runtime.sendMessage({
      type: 'AUTH_UPDATED',
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    }, (resp) => {
      console.log('[LSP] AUTH_UPDATED応答:', resp);
    });

    showDashboard();

    // Supabase REST APIで直接アカウント取得 → account_idをstorage保存
    await loadAccounts();
    loadDMQueueCount();
    loadSpyMsgCount();
  } catch (err) {
    const msg = err.message === 'Invalid login credentials'
      ? 'メールアドレスまたはパスワードが正しくありません'
      : err.message;
    console.error('[LSP] ログイン失敗: ', err.message);
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
    console.log('[LSP] アカウント選択:', id);
    // storage直接保存 + backgroundに通知
    chrome.storage.local.set({ account_id: id });
    chrome.runtime.sendMessage({ type: 'SET_ACCOUNT', account_id: id });
    loadDMQueueCount();
  }
});

// --- SPY Toggle ---
spyToggleBtn.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['spy_enabled']);
  const newState = !(data.spy_enabled === true);
  console.log('[LSP] SPY切替: ', data.spy_enabled, '→', newState);

  chrome.runtime.sendMessage({ type: 'TOGGLE_SPY', enabled: newState }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[LSP] TOGGLE_SPY送信失敗:', chrome.runtime.lastError.message);
      return;
    }
    console.log('[LSP] TOGGLE_SPY応答:', response);
    if (response && response.ok) {
      updateSpyButton(newState);
      if (newState) {
        const startedAt = new Date().toISOString();
        chrome.storage.local.set({ spy_started_at: startedAt });
        // spy_cast は content_spy.js が storage に書き込む
        setTimeout(() => {
          chrome.storage.local.get(['spy_cast'], (d) => {
            console.log('[LSP] SPY開始後 spy_cast=', d.spy_cast);
            updateSpyInfo(true, d.spy_cast, startedAt);
          });
        }, 2000); // content_spy がcast名を書き込む時間を待つ
        // まず即座に「監視中」だけ表示
        updateSpyInfo(true, null, startedAt);
      } else {
        chrome.storage.local.set({ spy_started_at: null, spy_cast: null });
        updateSpyInfo(false, null, null);
      }
    }
  });
});

// --- STT Toggle ---
$('sttToggleBtn').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['stt_enabled']);
  const newState = !(data.stt_enabled === true);
  console.log('[LSP] STT切替:', data.stt_enabled, '→', newState);

  chrome.runtime.sendMessage({ type: 'TOGGLE_STT', enabled: newState }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[LSP] TOGGLE_STT送信失敗:', chrome.runtime.lastError.message);
      return;
    }
    if (response && response.ok) {
      updateSTTButton(newState);
    }
  });
});

// --- Coin Sync ---
$('coinSyncBtn').addEventListener('click', async () => {
  const btn = $('coinSyncBtn');
  const statusEl = $('coinSyncStatus');
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

// --- Save Settings (Dashboard) ---
saveSettingsBtn.addEventListener('click', async () => {
  const url = apiUrlInput.value.trim();
  if (url) {
    await chrome.storage.local.set({ api_base_url: url });
    flashSaveSuccess($('saveSuccess'));
  }
});

// --- Save Settings (Login) ---
saveSettingsBtnLogin.addEventListener('click', async () => {
  const url = apiUrlInputLogin.value.trim();
  if (url) {
    await chrome.storage.local.set({ api_base_url: url });
    apiUrlInput.value = url;
    flashSaveSuccess($('saveSuccessLogin'));
  }
});

// --- Logout ---
logoutBtn.addEventListener('click', async () => {
  console.log('[LSP] ログアウト実行');
  if (spyElapsedTimer) {
    clearInterval(spyElapsedTimer);
    spyElapsedTimer = null;
  }
  // SPY/STT停止をbackgroundに通知
  chrome.runtime.sendMessage({ type: 'TOGGLE_SPY', enabled: false });
  chrome.runtime.sendMessage({ type: 'TOGGLE_STT', enabled: false });
  await chrome.storage.local.remove([
    'access_token', 'refresh_token', 'account_id',
    'user_email', 'logged_in', 'spy_enabled', 'stt_enabled',
    'spy_cast', 'spy_started_at',
    'last_coin_sync', 'coin_sync_count',
  ]);
  showLogin();
});

// --- Auto-refresh DM count & SPY count ---
setInterval(() => {
  loadDMQueueCount();
  loadSpyMsgCount();
}, 5000);

// --- Start ---
init();
