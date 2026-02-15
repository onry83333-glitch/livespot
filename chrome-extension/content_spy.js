/**
 * Strip Live Spot - Content SPY Script
 * Stripchatのチャット DOM を監視し、メッセージを background.js へリレー
 * A.2: 再接続ロジック + ハートビート
 */

(function () {
  'use strict';

  const LOG = '[LS-SPY]';
  let observer = null;
  let enabled = false;
  let castName = '';
  let processedIds = new Set();

  // SVG要素のclassNameはSVGAnimatedStringなので安全に取得するヘルパー
  function getClass(el) {
    if (!el) return '';
    if (typeof el.className === 'string') return el.className;
    return el.getAttribute('class') || '';
  }

  // A.2: 再接続・ハートビート用
  let lastMessageTime = 0;
  let staleCheckTimer = null;
  let urlCheckTimer = null;
  let heartbeatTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;

  // ============================================================
  // Cast Name 抽出
  // ============================================================
  function extractCastName() {
    // URL: https://stripchat.com/CastName or https://ja.stripchat.com/CastName
    const match = location.pathname.match(/^\/([^/\?#]+)/);
    if (match && match[1]) {
      const reserved = [
        'user', 'favorites', 'settings', 'messages',
        'login', 'signup', 'search', 'categories',
      ];
      if (!reserved.includes(match[1].toLowerCase())) {
        console.log(LOG, 'キャスト名抽出(URL):', match[1]);
        return match[1];
      }
    }
    // Fallback: ページタイトルから
    const titleMatch = document.title.match(/^(.+?)\s*[-|–]/);
    if (titleMatch) {
      console.log(LOG, 'キャスト名抽出(タイトル):', titleMatch[1].trim());
      return titleMatch[1].trim();
    }
    console.warn(LOG, 'キャスト名抽出: 取得できず URL=', location.href, 'title=', document.title);
    return '';
  }

  // ============================================================
  // Chat Container 発見（6段階フォールバック）
  // ============================================================
  function findChatContainer() {
    // Strategy 0 (最優先): Stripchat既知のセレクタ（2026年確認済み）
    const knownSelectors = [
      '.chat-list',
      '[class*="chatList"]',
      '[class*="chat-list"]',
      '[class*="ChatList"]',
      '.chat-content',
      '[class*="chatContent"]',
      '[class*="chat-content"]',
      'ul[class*="chat"]',
      'div[class*="chat"] ul',
      'div[class*="chat"] ol',
      '.chat-room-content',
      '.chat-messages',
      '[class*="ChatContent"]',
      '[class*="chatRoom"] [class*="content"]',
    ];
    for (const sel of knownSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          console.log(LOG, 'チャットコンテナ発見(既知セレクタ):', sel, 'tag:', el.tagName, '子要素数:', el.children.length, 'class:', getClass(el).substring(0, 80));
          return el;
        }
      } catch (e) {
        // invalid selector, skip
      }
    }

    // Strategy 1: data-testid
    let el = document.querySelector('[data-testid="chat-messages"]');
    if (el) {
      console.log(LOG, 'チャットコンテナ発見(data-testid) tag:', el.tagName, 'class:', getClass(el).substring(0, 80));
      return el;
    }

    // Strategy 2: class名パターン（複合）
    const candidates = document.querySelectorAll(
      '[class*="chat"][class*="list"], [class*="message"][class*="container"], [class*="chat"][class*="scroll"]'
    );
    for (const c of candidates) {
      if (c.children.length > 2) {
        console.log(LOG, 'チャットコンテナ発見(class複合):', getClass(c).substring(0, 80), '子要素数:', c.children.length);
        return c;
      }
    }

    // Strategy 3: chat panel 内のスクロール要素
    const chatPanel = document.querySelector(
      '.chat-panel, [class*="chatPanel"], [class*="ChatPanel"], [class*="chat-room"], [class*="chatRoom"]'
    );
    if (chatPanel) {
      console.log(LOG, 'チャットパネル発見:', getClass(chatPanel).substring(0, 80));
      const scrollable =
        chatPanel.querySelector('[style*="overflow"]') ||
        chatPanel.querySelector('[class*="scroll"]') ||
        chatPanel.querySelector('[class*="list"]') ||
        chatPanel.querySelector('[class*="content"]');
      if (scrollable) {
        console.log(LOG, 'チャットコンテナ発見(パネル内スクロール):', getClass(scrollable).substring(0, 80));
        return scrollable;
      }
      const panelStyle = getComputedStyle(chatPanel);
      if (panelStyle.overflowY === 'auto' || panelStyle.overflowY === 'scroll') {
        console.log(LOG, 'チャットコンテナ発見(パネル自体):', getClass(chatPanel).substring(0, 80));
        return chatPanel;
      }
    }

    // Strategy 4: ヒューリスティック — チャット領域内のスクロール可能な要素
    const allEls = document.querySelectorAll('div[class], ul[class], ol[class]');
    for (const div of allEls) {
      const cn = getClass(div);
      if (!/chat|Chat|message|Message/i.test(cn)) continue;
      const style = getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.children.length > 3
      ) {
        console.log(LOG, 'チャットコンテナ発見(ヒューリスティック):', cn.substring(0, 80), '子要素数:', div.children.length);
        return div;
      }
    }

    // Strategy 5: 最終手段 — overflow:auto/scroll で子要素が多い要素
    for (const div of allEls) {
      const style = getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.children.length > 10 &&
        div.scrollHeight > div.clientHeight
      ) {
        console.log(LOG, 'チャットコンテナ発見(最終手段):', getClass(div).substring(0, 80), '子要素数:', div.children.length);
        return div;
      }
    }

    // デバッグ: ページ上のchat関連要素を詳細列挙（最大15個）
    const chatRelated = document.querySelectorAll('[class*="chat"], [class*="Chat"]');
    console.warn(LOG, '=== チャットコンテナ未発見 ===');
    console.warn(LOG, 'chat関連要素数:', chatRelated.length);
    chatRelated.forEach((el, i) => {
      if (i < 15) {
        const cn = getClass(el);
        const style = getComputedStyle(el);
        console.log(LOG, `  [${i}] <${el.tagName.toLowerCase()}> class="${cn.substring(0, 120)}" 子=${el.children.length} overflow=${style.overflowY} size=${el.scrollWidth}x${el.scrollHeight}`);
      }
    });

    return null;
  }

  // ============================================================
  // メッセージ解析
  // ============================================================
  function parseMessageNode(node) {
    if (node.nodeType !== 1) return null;
    if (node.dataset?.lsParsed) return null;

    const fullText = (node.textContent || '').trim();
    if (!fullText) return null;

    // 重複チェック
    const nodeId = hashCode(fullText + node.childElementCount);
    if (processedIds.has(nodeId)) return null;
    processedIds.add(nodeId);
    if (processedIds.size > 1000) {
      const arr = Array.from(processedIds);
      processedIds = new Set(arr.slice(-500));
    }

    node.dataset.lsParsed = '1';

    let userName = '';
    let message = '';
    let msgType = 'chat';
    let tokens = 0;
    let isVip = false;

    // --- ユーザー名抽出 ---
    const userLink = node.querySelector(
      'a[href*="/user/"], a[href*="stripchat.com/"]'
    );
    if (userLink) {
      userName = (userLink.textContent || '').trim();
      if (!userName) {
        const hrefMatch = (userLink.href || '').match(/\/([^/]+)\/?$/);
        userName = hrefMatch ? hrefMatch[1] : '';
      }
    }
    if (!userName) {
      const userSpan = node.querySelector(
        '[class*="username"], [class*="userName"], [class*="UserName"], [class*="user-name"], [class*="user"], [class*="User"], [class*="nick"], [class*="Nick"], [class*="author"], [class*="Author"]'
      );
      if (userSpan) userName = (userSpan.textContent || '').trim();
    }

    // --- メッセージ本文 ---
    // まず専用のテキスト要素を探す
    const textSpan = node.querySelector(
      '[class*="text"], [class*="Text"], [class*="message-text"], [class*="messageText"], [class*="content"]'
    );
    if (textSpan && textSpan !== node) {
      message = (textSpan.textContent || '').trim();
    } else if (userName && fullText.includes(userName)) {
      message = fullText
        .substring(fullText.indexOf(userName) + userName.length)
        .replace(/^[\s:：\-—]+/, '')
        .trim();
    } else {
      message = fullText;
    }

    // --- msg_type 判定 ---
    // Tip
    const tokenMatch = message.match(/(\d+)\s*(?:tokens?|tk|トークン)/i);
    if (tokenMatch) {
      tokens = parseInt(tokenMatch[1], 10);
      msgType = 'tip';
    }

    // Gift
    if (
      node.querySelector(
        '[class*="gift"], [class*="Gift"], [class*="reward"], img[src*="gift"]'
      )
    ) {
      msgType = 'gift';
      if (!tokens) {
        const giftTokens = message.match(/(\d+)/);
        if (giftTokens) tokens = parseInt(giftTokens[1], 10);
      }
    }

    // Enter / Leave
    if (/joined|entered|入室|has entered/i.test(fullText) && !message) {
      msgType = 'enter';
    }
    if (/left|退室|has left/i.test(fullText)) {
      msgType = 'leave';
    }

    // System
    if (
      !userName &&
      node.querySelector(
        '[class*="system"], [class*="System"], [class*="notice"], [class*="Notice"]'
      )
    ) {
      msgType = 'system';
    }

    // VIP
    if (
      node.querySelector(
        '[class*="vip"], [class*="Vip"], [class*="crown"], [class*="premium"], [class*="whale"], [class*="badge"]'
      )
    ) {
      isVip = true;
    }

    // ユーザー名もメッセージも取れなかったら無視
    if (!userName && msgType === 'chat') return null;

    return {
      user_name: userName,
      message: message || null,
      msg_type: msgType,
      tokens,
      is_vip: isVip,
      metadata: { source: 'dom_observer' },
    };
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  // ============================================================
  // Observer
  // ============================================================
  function startObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    castName = extractCastName();
    if (!castName) {
      console.log(LOG, 'キャストページではないためスキップ');
      return;
    }
    // ポップアップの状態表示用に保存
    chrome.storage.local.set({ spy_cast: castName });

    const container = findChatContainer();
    if (!container) {
      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        console.log(LOG, `チャットコンテナ未発見 リトライ ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} (3秒後)...`);
        setTimeout(startObserving, 3000);
      } else {
        console.error(LOG, 'リトライ上限到達 チャットコンテナを発見できませんでした');
      }
      return;
    }

    reconnectAttempts = 0;
    lastMessageTime = Date.now();
    console.log(LOG, `=== チャット監視開始: ${castName} コンテナ: <${container.tagName.toLowerCase()}> class="${getClass(container).substring(0, 80)}" ===`);

    // 既存の子要素を解析（初回スキャン）
    let initialCount = 0;
    for (const child of container.children) {
      const parsed = parseMessageNode(child);
      if (parsed) {
        initialCount++;
        chrome.runtime.sendMessage({
          type: 'CHAT_MESSAGE',
          cast_name: castName,
          message_time: new Date().toISOString(),
          ...parsed,
        });
      }
    }
    if (initialCount > 0) {
      console.log(LOG, `初回スキャン: ${initialCount}件のメッセージを送信`);
    }

    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let newMsgCount = 0;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          const parsed = parseMessageNode(node);
          if (parsed) {
            lastMessageTime = Date.now();
            newMsgCount++;
            chrome.runtime.sendMessage({
              type: 'CHAT_MESSAGE',
              cast_name: castName,
              message_time: new Date().toISOString(),
              ...parsed,
            });
          }
        }
      }
      if (newMsgCount > 0) {
        console.log(LOG, `新メッセージ検出: ${newMsgCount}件 → background送信`);
      }
    });

    observer.observe(container, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
      console.log(LOG, 'Observer切断');
    }
  }

  // ============================================================
  // A.2: 再接続ロジック — 30秒無メッセージで再スキャン
  // ============================================================
  function startStaleCheck() {
    if (staleCheckTimer) return;
    staleCheckTimer = setInterval(() => {
      if (!enabled || !observer) return;

      const elapsed = Date.now() - lastMessageTime;
      if (elapsed > 30000) {
        console.log(LOG, `${Math.round(elapsed / 1000)}秒間メッセージなし → 再接続試行`);
        reconnect();
      }
    }, 10000);
  }

  function stopStaleCheck() {
    if (staleCheckTimer) {
      clearInterval(staleCheckTimer);
      staleCheckTimer = null;
    }
  }

  // ============================================================
  // A.2: URL変化チェック (5秒間隔) — SPA対応
  // ============================================================
  let lastUrl = location.href;

  function startUrlCheck() {
    if (urlCheckTimer) return;
    urlCheckTimer = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log(LOG, 'URL変化検出(interval) → 再初期化');
        reconnect();
      }

      // チャットコンテナが消えた場合も再接続
      if (enabled && observer) {
        const container = findChatContainer();
        if (!container) {
          console.log(LOG, 'チャットコンテナ消失 → 再接続試行');
          reconnect();
        }
      }
    }, 5000);
  }

  function stopUrlCheck() {
    if (urlCheckTimer) {
      clearInterval(urlCheckTimer);
      urlCheckTimer = null;
    }
  }

  // ============================================================
  // A.2: 再接続実行
  // ============================================================
  function reconnect() {
    stopObserving();
    processedIds.clear();
    reconnectAttempts = 0;

    setTimeout(() => {
      if (enabled) {
        startObserving();
        startViewerStatsPolling();
      }
    }, 2000);
  }

  // ============================================================
  // A.2: ハートビート — 60秒ごとに background.js へ送信
  // ============================================================
  function startHeartbeat() {
    if (heartbeatTimer) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, 60000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function sendHeartbeat() {
    try {
      chrome.runtime.sendMessage({
        type: 'HEARTBEAT',
        timestamp: new Date().toISOString(),
        castName: castName,
        observing: !!observer,
        messageCount: processedIds.size,
      });
    } catch (e) {
      console.warn(LOG, 'ハートビート送信失敗:', e.message);
      stopHeartbeat();
    }
  }

  // ============================================================
  // Message Handlers
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SPY_STATE') {
      console.log(LOG, 'SPY状態変更受信: enabled=', msg.enabled);
      enabled = msg.enabled;
      if (enabled) {
        startObserving();
        startViewerStatsPolling();
        startStaleCheck();
        startUrlCheck();
        startHeartbeat();
      } else {
        stopObserving();
        stopViewerStatsPolling();
        stopStaleCheck();
        stopUrlCheck();
        stopHeartbeat();
      }
      sendResponse({ ok: true });
    }
  });

  // ============================================================
  // SPA Navigation 対応 (MutationObserver — バックアップ)
  // ============================================================
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log(LOG, 'URL変化検出(mutation) → 再初期化');
      stopObserving();
      stopViewerStatsPolling();
      processedIds.clear();
      reconnectAttempts = 0;
      setTimeout(() => {
        if (enabled) {
          startObserving();
          startViewerStatsPolling();
        }
      }, 2000);
    }
  });

  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ============================================================
  // 視聴者数カウント取得
  // ============================================================
  let lastViewerStats = null;
  let viewerStatsTimer = null;

  function getViewerStats() {
    try {
      let total = null;
      let coinUsers = null;
      let others = null;

      const totalEl = document.querySelector('div.model-chat-users-info-watching-now');
      if (totalEl) {
        const m = (totalEl.textContent || '').match(/(\d+)/);
        if (m) total = parseInt(m[1], 10);
      }

      const infoItems = document.querySelectorAll('div.model-chat-users-info-item span.info-item-grey');
      if (infoItems.length >= 1) {
        const m1 = (infoItems[0].textContent || '').match(/(\d+)/);
        if (m1) coinUsers = parseInt(m1[1], 10);
      }
      if (infoItems.length >= 2) {
        const m2 = (infoItems[1].textContent || '').match(/(\d+)/);
        if (m2) others = parseInt(m2[1], 10);
      }

      if (total === null && coinUsers === null) return;

      const stats = { total, coin_users: coinUsers, others };
      const key = `${stats.total}:${stats.coin_users}:${stats.others}`;
      const lastKey = lastViewerStats
        ? `${lastViewerStats.total}:${lastViewerStats.coin_users}:${lastViewerStats.others}`
        : null;

      if (key !== lastKey) {
        lastViewerStats = stats;
        chrome.runtime.sendMessage({
          type: 'VIEWER_STATS',
          cast_name: castName,
          total: stats.total,
          coin_users: stats.coin_users,
          others: stats.others,
          timestamp: new Date().toISOString(),
        });
        console.log(LOG, '視聴者数送信:', stats);
      }
    } catch (e) {
      // DOM not ready yet
    }
  }

  function startViewerStatsPolling() {
    if (viewerStatsTimer) return;
    getViewerStats();
    viewerStatsTimer = setInterval(getViewerStats, 180000);
    console.log(LOG, '視聴者数ポーリング開始(180秒間隔)');
  }

  function stopViewerStatsPolling() {
    if (viewerStatsTimer) {
      clearInterval(viewerStatsTimer);
      viewerStatsTimer = null;
      lastViewerStats = null;
    }
  }

  // ============================================================
  // 初期化
  // ============================================================
  console.log(LOG, '=== Content SPYスクリプト読込 === URL:', location.href);

  chrome.storage.local.get(['spy_enabled'], (data) => {
    enabled = data.spy_enabled === true;
    console.log(LOG, 'Storage読込: spy_enabled=', enabled);
    if (enabled) {
      const start = () => {
        console.log(LOG, 'SPY自動開始(storage復元)');
        setTimeout(startObserving, 1000);
        setTimeout(startViewerStatsPolling, 2000);
        startStaleCheck();
        startUrlCheck();
        startHeartbeat();
      };
      if (document.readyState === 'complete') {
        start();
      } else {
        window.addEventListener('load', start);
      }
    } else {
      console.log(LOG, 'SPY無効状態 待機中');
    }
  });
})();
