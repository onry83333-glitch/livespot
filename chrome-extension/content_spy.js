/**
 * Strip Live Spot - Content SPY Script
 * Stripchatのチャット DOM を監視し、メッセージを background.js へリレー
 * A.2: 再接続ロジック + ハートビート
 */

(function () {
  'use strict';

  const LOG = '[LS-SPY]';

  // JWT capture relay: MAIN world → content script → background.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'LS_JWT_CAPTURED') {
      chrome.runtime.sendMessage({
        type: 'JWT_CAPTURED',
        jwt: event.data.jwt,
        source: event.data.source,
        timestamp: event.data.timestamp,
      });
    }
  });

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
  // Broadcast Title 抽出
  // ============================================================
  let lastBroadcastTitle = null;

  function extractBroadcastTitle() {
    const titleEl = document.querySelector('.view-cam-info-topic');
    if (titleEl) {
      return titleEl.textContent.trim() || null;
    }
    return null;
  }

  /**
   * 配信タイトルをチェックして、変更があれば background.js に送信
   */
  function checkBroadcastTitle() {
    if (!enabled || !castName) return;
    const title = extractBroadcastTitle();
    if (title && title !== lastBroadcastTitle) {
      lastBroadcastTitle = title;
      console.log(LOG, '配信タイトル検出:', title);
      try {
        chrome.runtime.sendMessage({
          type: 'BROADCAST_TITLE',
          cast_name: castName,
          broadcast_title: title,
        });
      } catch (e) {
        console.warn(LOG, '配信タイトル送信失敗:', e.message);
      }
    }
  }

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
  // ユーザーリスト / 視聴者リストの除外判定
  // ============================================================
  const USERLIST_RE = /user.?list|userList|UserList|viewer|Viewer|member|Member|people|People|online|Online|spectator|Spectator|fan.?list|FanList/i;

  function isUserListElement(el) {
    // 自身のclass
    if (USERLIST_RE.test(getClass(el))) return true;
    // 祖先3段階チェック
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (USERLIST_RE.test(getClass(p))) return true;
      p = p.parentElement;
    }
    return false;
  }

  // チャットメッセージっぽい子要素を持つかサンプリング判定
  // ユーザーリスト: 子要素がリンク1個だけ（ユーザー名のみ）
  // チャット: 子要素にユーザー名 + テキスト本文がある
  function looksLikeChatContainer(el) {
    const kids = el.children;
    if (kids.length < 2) return false;
    // 最大10個をサンプリング
    let chatLike = 0;
    let listLike = 0;
    const sample = Math.min(kids.length, 10);
    for (let i = 0; i < sample; i++) {
      const child = kids[kids.length - 1 - i]; // 末尾（最新）から
      const text = (child.textContent || '').trim();
      const links = child.querySelectorAll('a');
      const hasTextSpan = child.querySelector(
        '[class*="text"], [class*="Text"], [class*="content"], [class*="Content"], [class*="message"], [class*="Message"]'
      );
      // ユーザーリスト項目の特徴: テキストが短い & リンク1個のみ & テキスト要素なし
      if (text.length < 40 && links.length <= 1 && !hasTextSpan && child.childElementCount <= 3) {
        listLike++;
      } else {
        chatLike++;
      }
    }
    console.log(LOG, `  コンテナ判定: chatLike=${chatLike} listLike=${listLike} / ${sample}サンプル`);
    return chatLike > listLike;
  }

  // ============================================================
  // Chat Container 発見（6段階フォールバック + ユーザーリスト除外）
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
        if (el && !isUserListElement(el)) {
          console.log(LOG, 'チャットコンテナ発見(既知セレクタ):', sel, 'tag:', el.tagName, '子要素数:', el.children.length, 'class:', getClass(el).substring(0, 80));
          return el;
        }
      } catch (e) {
        // invalid selector, skip
      }
    }

    // Strategy 1: data-testid
    let el = document.querySelector('[data-testid="chat-messages"]');
    if (el && !isUserListElement(el)) {
      console.log(LOG, 'チャットコンテナ発見(data-testid) tag:', el.tagName, 'class:', getClass(el).substring(0, 80));
      return el;
    }

    // Strategy 2: class名パターン（複合）— ユーザーリスト除外
    const candidates = document.querySelectorAll(
      '[class*="chat"][class*="list"], [class*="message"][class*="container"], [class*="chat"][class*="scroll"]'
    );
    for (const c of candidates) {
      if (c.children.length > 2 && !isUserListElement(c) && looksLikeChatContainer(c)) {
        console.log(LOG, 'チャットコンテナ発見(class複合):', getClass(c).substring(0, 80), '子要素数:', c.children.length);
        return c;
      }
    }

    // Strategy 3: chat panel 内のスクロール要素
    const chatPanel = document.querySelector(
      '.chat-panel, [class*="chatPanel"], [class*="ChatPanel"], [class*="chat-room"], [class*="chatRoom"]'
    );
    if (chatPanel && !isUserListElement(chatPanel)) {
      console.log(LOG, 'チャットパネル発見:', getClass(chatPanel).substring(0, 80));
      // パネル内のスクロール要素を探す — ユーザーリスト系を除外
      const scrollCandidates = chatPanel.querySelectorAll(
        '[style*="overflow"], [class*="scroll"], [class*="list"], [class*="content"]'
      );
      for (const sc of scrollCandidates) {
        if (!isUserListElement(sc) && sc.children.length > 2) {
          if (looksLikeChatContainer(sc)) {
            console.log(LOG, 'チャットコンテナ発見(パネル内):', getClass(sc).substring(0, 80));
            return sc;
          }
        }
      }
      const panelStyle = getComputedStyle(chatPanel);
      if ((panelStyle.overflowY === 'auto' || panelStyle.overflowY === 'scroll') && looksLikeChatContainer(chatPanel)) {
        console.log(LOG, 'チャットコンテナ発見(パネル自体):', getClass(chatPanel).substring(0, 80));
        return chatPanel;
      }
    }

    // Strategy 4: ヒューリスティック — chat/message キーワード + スクロール
    const allEls = document.querySelectorAll('div[class], ul[class], ol[class]');
    for (const div of allEls) {
      const cn = getClass(div);
      if (!/chat|Chat|message|Message/i.test(cn)) continue;
      if (isUserListElement(div)) continue;
      const style = getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.children.length > 3 &&
        looksLikeChatContainer(div)
      ) {
        console.log(LOG, 'チャットコンテナ発見(ヒューリスティック):', cn.substring(0, 80), '子要素数:', div.children.length);
        return div;
      }
    }

    // Strategy 5: 最終手段 — overflow:auto/scroll で子要素が多い要素（ユーザーリスト除外 + チャット判定必須）
    for (const div of allEls) {
      if (isUserListElement(div)) continue;
      const style = getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.children.length > 10 &&
        div.scrollHeight > div.clientHeight &&
        looksLikeChatContainer(div)
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
        console.log(LOG, `  [${i}] <${el.tagName.toLowerCase()}> class="${cn.substring(0, 120)}" 子=${el.children.length} overflow=${style.overflowY} size=${el.scrollWidth}x${el.scrollHeight} userList=${isUserListElement(el)}`);
      }
    });

    return null;
  }

  // ============================================================
  // Message classifier — strict rules (safety net)
  // ============================================================
  function classifyMessage(rawMessage, extractedUserName, extractedTokens) {
    // Rule 1: No user_name = never a tip
    if (!extractedUserName || extractedUserName.trim() === '') {
      const goalKeywords = ['ゴール', 'goal', 'エピックゴール', 'epic goal', '達成', 'achieved', '残り', 'remaining', '新しいゴール', 'new goal'];
      const msgLower = (rawMessage || '').toLowerCase();
      const isGoal = goalKeywords.some(kw => msgLower.includes(kw.toLowerCase()));

      if (isGoal) {
        return { msg_type: 'goal', tokens: 0, user_name: '', message: rawMessage };
      }
      return { msg_type: 'system', tokens: 0, user_name: '', message: rawMessage };
    }

    // Rule 2: user_name exists + tokens > 0 = tip
    if (extractedTokens && extractedTokens > 0) {
      return { msg_type: 'tip', tokens: extractedTokens, user_name: extractedUserName, message: rawMessage };
    }

    // Rule 3: user_name exists, no tokens
    const enterKeywords = ['has joined', 'joined the room', 'が入室'];
    if (enterKeywords.some(kw => (rawMessage || '').toLowerCase().includes(kw.toLowerCase()))) {
      return { msg_type: 'enter', tokens: 0, user_name: extractedUserName, message: rawMessage };
    }

    return { msg_type: 'chat', tokens: 0, user_name: extractedUserName, message: rawMessage };
  }

  // Final validation before saving — safety net
  function validateTipBeforeSave(data) {
    // 1. Empty user_name tips are forbidden
    if (data.msg_type === 'tip' && (!data.user_name || data.user_name.trim() === '')) {
      console.warn(LOG, 'チップ拒否: user_name空', (data.message || '').substring(0, 50));
      data.msg_type = 'system';
      data.tokens = 0;
      return data;
    }

    // 2. Goal keywords in tip messages are forbidden
    const goalPatterns = [/ゴール/, /goal/i, /エピック/, /epic/i, /達成/, /残り.*コイン/, /新しいゴール/, /new goal/i];
    if (data.msg_type === 'tip' && goalPatterns.some(p => p.test(data.message || ''))) {
      console.warn(LOG, 'チップ拒否: ゴール系メッセージ', (data.message || '').substring(0, 50));
      data.msg_type = 'goal';
      data.tokens = 0;
      return data;
    }

    // 3. Log high-value tips (warning only)
    if (data.msg_type === 'tip' && data.tokens >= 5000) {
      console.warn(LOG, '高額チップ検出:', data.user_name, data.tokens, 'tk');
    }

    return data;
  }

  // ============================================================
  // メッセージ解析
  // ============================================================
  function parseMessageNode(node) {
    if (node.nodeType !== 1) return null;
    if (node.dataset?.lsParsed) return null;

    // ユーザーリスト内の要素は即スキップ
    if (isUserListElement(node)) {
      node.dataset.lsParsed = '1';
      return null;
    }

    const fullText = (node.textContent || '').trim();
    if (!fullText) return null;

    // ★ Multi-message wrapper detection:
    // このノードの直接の子要素が複数のユーザーリンクを含む場合、
    // 複数メッセージを束ねたラッパーと判断。
    // → null を返す（lsParsed はセットしない）ので parseOneOrMany() が子要素を再帰処理する。
    let childrenWithUser = 0;
    for (const child of node.children) {
      if (child.querySelector('a[href*="/user/"], a[href*="stripchat.com/"]') ||
          child.querySelector('[class*="username"], [class*="userName"], [class*="UserName"], [class*="nick"], [class*="Nick"]')) {
        childrenWithUser++;
        if (childrenWithUser > 1) return null;
      }
    }

    // ユーザーリスト項目の早期検出:
    // テキストが短い(40文字以下) + 子要素が少ない(3個以下) + テキスト要素なし
    // → ユーザー名だけの行 = 視聴者リスト
    if (fullText.length <= 40 && node.childElementCount <= 3) {
      const hasTextEl = node.querySelector(
        '[class*="text"], [class*="Text"], [class*="content"], [class*="Content"], [class*="message"], [class*="Message"]'
      );
      if (!hasTextEl) {
        // さらにチェック: 数字プレフィックス付きのユーザー名パターン（例: "42houkeisan"）
        if (/^\d+[a-zA-Z]/.test(fullText) || /^\d+$/.test(fullText)) {
          node.dataset.lsParsed = '1';
          return null;
        }
        // リンクが1個だけでテキストがリンクテキストと同一 → ユーザーリスト項目
        const links = node.querySelectorAll('a');
        if (links.length === 1) {
          const linkText = (links[0].textContent || '').trim();
          if (fullText === linkText || fullText.replace(/\s+/g, '') === linkText.replace(/\s+/g, '')) {
            node.dataset.lsParsed = '1';
            return null;
          }
        }
      }
    }

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
    let userColor = null;
    let userLeague = null;
    let userLevel = null;
    let message = '';
    let msgType = 'chat';
    let tokens = 0;
    let isVip = false;

    // League color table (Stripchat 7 tiers)
    const LEAGUE_COLORS = {
      grey: '#888888',
      bronze: '#de884a',
      silver: '#c0c0c0',
      gold: '#ffcc00',
      diamond: '#b9f2ff',
      royal: '#ff1a1a',
      legend: '#9933ff',
    };

    // --- ユーザー名抽出 + カラー取得 ---
    const userLink = node.querySelector(
      'a[href*="/user/"], a[href*="stripchat.com/"]'
    );
    if (userLink) {
      userName = (userLink.textContent || '').trim();
      // hrefから正規ユーザー名を取得（数字プレフィックス修正用）
      const hrefMatch = (userLink.href || '').match(/\/([^/\?#]+)\/?$/);
      const hrefName = hrefMatch ? decodeURIComponent(hrefMatch[1]) : '';
      if (!userName) {
        userName = hrefName;
      } else if (hrefName && userName !== hrefName && userName.endsWith(hrefName)) {
        // textContent="94DrinkTea9" だが href="/DrinkTea9" → DOM数字プレフィックスを除去
        console.log(LOG, '数字プレフィックス修正(href照合):', userName, '→', hrefName);
        userName = hrefName;
      }
    }
    if (!userName) {
      const userSpan = node.querySelector(
        '[class*="username"], [class*="userName"], [class*="UserName"], [class*="user-name"], [class*="nick"], [class*="Nick"], [class*="author"], [class*="Author"]'
      );
      if (userSpan) {
        userName = (userSpan.textContent || '').trim();
      }
    }

    // --- League color extraction (primary method) ---
    // Look for color-league-{name} CSS class in the node or its descendants
    const leagueEl = node.querySelector('[class*="color-league-"]');
    if (leagueEl) {
      const leagueClasses = getClass(leagueEl);
      const leagueMatch = leagueClasses.match(/color-league-(\w+)/);
      if (leagueMatch) {
        userLeague = leagueMatch[1];
        userColor = LEAGUE_COLORS[userLeague] || null;
      }
    }

    // Fallback: getComputedStyle if no league class found
    if (!userColor) {
      const colorTarget = userLink || node.querySelector(
        '[class*="username"], [class*="userName"], [class*="UserName"], [class*="user-name"], [class*="nick"], [class*="Nick"], [class*="author"], [class*="Author"]'
      );
      if (colorTarget) {
        try { userColor = window.getComputedStyle(colorTarget).color || null; } catch (e) { /* ignore */ }
      }
    }

    // --- User level extraction ---
    // Level badge: look for level number near the username (e.g. "(67)" or just "67")
    const levelEl = node.querySelector('[class*="user-level"], [class*="userLevel"], [class*="UserLevel"], [class*="level-badge"], [class*="levelBadge"]');
    if (levelEl) {
      const levelMatch = (levelEl.textContent || '').match(/(\d+)/);
      if (levelMatch) {
        userLevel = parseInt(levelMatch[1], 10);
      }
    }
    // Fallback: look for the level number in the username-level-wrapper structure
    if (userLevel === null) {
      const wrapperEl = node.querySelector('[class*="username-level"], [class*="usernameLevel"]');
      if (wrapperEl) {
        const levelNumMatch = (wrapperEl.textContent || '').match(/\((\d+)\)/);
        if (levelNumMatch) {
          userLevel = parseInt(levelNumMatch[1], 10);
        }
      }
    }

    // --- メッセージ本文 ---
    // まず専用のテキスト要素を探す（ユーザー名要素を除外）
    const userEl = userLink || node.querySelector(
      '[class*="username"], [class*="userName"], [class*="UserName"], [class*="user-name"], [class*="nick"], [class*="Nick"], [class*="author"], [class*="Author"]'
    );
    const textSpan = node.querySelector(
      '[class*="message-text"], [class*="messageText"], [class*="MessageText"]'
    );
    // textSpan がユーザー名要素と異なるかつユーザー名を含まない場合のみ使用
    if (textSpan && textSpan !== node && textSpan !== userEl) {
      const spanText = (textSpan.textContent || '').trim();
      // textSpanがユーザー名で始まる場合はstrip
      if (userName && spanText.startsWith(userName)) {
        message = spanText.substring(userName.length).replace(/^[\s:：\-—]+/, '').trim();
      } else {
        message = spanText;
      }
    } else if (userName && fullText.startsWith(userName)) {
      // テキスト先頭がユーザー名 → 除去して本文を取得
      message = fullText
        .substring(userName.length)
        .replace(/^[\s:：\-—]+/, '')
        .trim();
    } else if (userName && fullText.includes(userName)) {
      message = fullText
        .substring(fullText.indexOf(userName) + userName.length)
        .replace(/^[\s:：\-—]+/, '')
        .trim();
    } else {
      message = fullText;
    }

    // 最終ガード: messageがまだユーザー名で始まっていたら除去
    if (userName && message && message.startsWith(userName)) {
      message = message.substring(userName.length).replace(/^[\s:：\-—]+/, '').trim();
    }

    // --- msg_type 判定 ---

    // Goal / システムメッセージ — ゴール関連通知はチップではない
    // 「Xコインでゴール」「新しいゴール – Xコイン...」「Goal達成」等
    // 「エピックゴールを達成するまで残り XXXX コイン」等
    const isGoalMessage = (
      /\d+\s*コインでゴール/.test(fullText) ||
      /新しいゴール/.test(fullText) ||
      /ゴール達成/.test(fullText) ||
      /ゴールを達成/.test(fullText) ||
      /エピックゴール/.test(fullText) ||
      /epic\s*goal/i.test(fullText) ||
      /残り.*コイン/.test(fullText) ||
      /remaining.*coin/i.test(fullText) ||
      /New\s+Goal/i.test(fullText) ||
      /Goal[：:\s\-–—]+\d+/i.test(fullText) ||
      /goal.*achieved/i.test(fullText) ||
      /achieved.*goal/i.test(fullText)
    );
    if (isGoalMessage) {
      msgType = 'goal';
      tokens = 0; // ゴール残り/設定コイン数はチップ額ではない
      if (!userName) userName = '';
      message = fullText;
    }

    // Tip — トークン数検出（ゴール以外）
    // (?:^|\s) で数字の前にスペースか行頭を要求 → ユーザー名内の数字を誤検出しない
    // 例: "masagoro5379コイン補充" → 5379の前が文字なのでマッチしない
    if (msgType !== 'goal') {
      const tokenMatch = fullText.match(/(?:^|\s)(\d+)\s*(?:tokens?|tk|トークン|コイン)/i);
      if (tokenMatch) {
        tokens = parseInt(tokenMatch[1], 10);
        msgType = 'tip';
      }
    }

    // Tip — テキストからユーザー名を抽出（DOMから取れなかった場合）
    if (msgType === 'tip' && !userName) {
      const tipPatterns = [
        /^(.+?)\s+tipped\s+\d+/i,                       // "User tipped 50 tokens"
        /^(.+?)\s+sent\s+\d+/i,                         // "User sent 50 tokens"
        /^(.+?)\s*さんが\s*\d+\s*(?:コイン|トークン)/,   // "Userさんが 50 コイン"
        /^(.+?)\s+が\s+\d+\s*tk/i,                      // "User が 50 tk"
        /^(.+?)\s+(?:tipped|sent|gave)/i,               // "User tipped/sent/gave"
      ];
      for (const pat of tipPatterns) {
        const m = fullText.match(pat);
        if (m && m[1].trim().length > 0 && m[1].trim().length < 50) {
          userName = m[1].trim();
          break;
        }
      }
    }

    // Safety net: tip with no user_name → reclassify via classifyMessage
    if (msgType === 'tip' && (!userName || userName.trim() === '')) {
      const reclassified = classifyMessage(fullText, userName, tokens);
      msgType = reclassified.msg_type;
      tokens = reclassified.tokens;
      userName = reclassified.user_name;
      console.warn(LOG, 'Tip再分類(user_name空):', msgType, fullText.substring(0, 60));
    }

    // Gift — DOM要素ベース
    if (
      node.querySelector(
        '[class*="gift"], [class*="Gift"], [class*="reward"], img[src*="gift"]'
      )
    ) {
      msgType = 'gift';
      if (!tokens) {
        const giftTokens = fullText.match(/(\d+)\s*(?:tokens?|tk|トークン|コイン)?/i);
        if (giftTokens) tokens = parseInt(giftTokens[1], 10);
      }
      // Gift でもユーザー名をテキストから抽出
      if (!userName) {
        const giftPatterns = [
          /^(.+?)\s+(?:sent|gave|gifted)/i,
          /^(.+?)\s*さんが.*(?:プレゼント|ギフト)/,
        ];
        for (const pat of giftPatterns) {
          const m = fullText.match(pat);
          if (m && m[1].trim().length > 0 && m[1].trim().length < 50) {
            userName = m[1].trim();
            break;
          }
        }
      }
    }

    // Group Chat Join / End — MUST be checked BEFORE generic enter/leave
    const groupJoinPatterns = [
      /^(.+?)\s+joined\s+the\s+group\s+chat/i,           // "User joined the group chat"
      /^(.+?)\s+entered\s+the\s+group\s+chat/i,          // "User entered the group chat"
      /^(.+?)\s+has\s+joined\s+the\s+group\s+chat/i,     // "User has joined the group chat"
      /^(.+?)\s*さんがグループチャットに参加/,              // "Userさんがグループチャットに参加しました"
      /^(.+?)\s*がグループチャットに(?:参加|入室)/,         // "Userがグループチャットに参加しました"
    ];
    const groupEndPatterns = [
      /group\s+chat\s+(?:has\s+)?ended/i,                 // "Group chat ended" / "Group chat has ended"
      /the\s+group\s+chat\s+(?:has\s+)?ended/i,           // "The group chat has ended"
      /グループチャットが終了/,                             // "グループチャットが終了しました"
      /^(.+?)\s+left\s+the\s+group\s+chat/i,              // "User left the group chat"
      /^(.+?)\s+has\s+left\s+the\s+group\s+chat/i,        // "User has left the group chat"
      /^(.+?)\s*さんがグループチャットから退室/,             // "Userさんがグループチャットから退室しました"
    ];

    if (msgType === 'chat') {
      for (const pat of groupJoinPatterns) {
        const m = fullText.match(pat);
        if (m && m[1] && m[1].trim().length > 0 && m[1].trim().length < 50) {
          msgType = 'group_join';
          if (!userName) userName = m[1].trim();
          message = '';
          break;
        }
      }
    }
    if (msgType === 'chat') {
      for (const pat of groupEndPatterns) {
        const m = fullText.match(pat);
        if (m) {
          msgType = 'group_end';
          // group_end patterns may or may not capture a user_name
          if (m[1] && m[1].trim().length > 0 && m[1].trim().length < 50) {
            if (!userName) userName = m[1].trim();
          }
          message = '';
          break;
        }
      }
    }

    // Enter / Leave — テキストパターンで判定 + ユーザー名抽出
    // NOTE: Generic enter/leave patterns below; group chat patterns are handled above
    const enterPatterns = [
      /^(.+?)\s+has joined/i,                            // "User has joined"
      /^(.+?)\s+joined\s+the\s+chat/i,                   // "User joined the chat" (NOT group chat)
      /^(.+?)\s+entered/i,                               // "User entered"
      /^(.+?)\s+has entered/i,                           // "User has entered"
      /^(.+?)\s+entered\s+the\s+chat/i,                  // "User entered the chat" (NOT group chat)
      /^(.+?)\s+is\s+here/i,                             // "User is here"
      /^(.+?)\s+arrived/i,                               // "User arrived"
      /^(.+?)\s*さんが(?!グループ).*(?:参加|入室)/,        // 参加/入室 (NOT グループチャット)
      /^(.+?)\s*が(?!グループ)(?:参加|入室)しました/,      // 参加/入室しました (NOT グループ)
    ];
    const leavePatterns = [
      /^(.+?)\s+has left/i,                              // "User has left"
      /^(.+?)\s+left\s+the\s+chat/i,                     // "User left the chat" (NOT group chat)
      /^(.+?)\s+left/i,                                  // "User left"
      /^(.+?)\s+has gone/i,                              // "User has gone"
      /^(.+?)\s+departed/i,                              // "User departed"
      /^(.+?)\s+exited/i,                                // "User exited"
      /^(.+?)\s*さんが(?!グループ).*退室/,                 // 退室 (NOT グループチャット)
      /^(.+?)\s*が(?!グループ)退室しました/,               // 退室しました (NOT グループ)
    ];

    if (msgType === 'chat') {
      for (const pat of enterPatterns) {
        const m = fullText.match(pat);
        if (m && m[1].trim().length > 0 && m[1].trim().length < 50) {
          msgType = 'enter';
          if (!userName) userName = m[1].trim();
          message = '';
          break;
        }
      }
    }
    if (msgType === 'chat') {
      for (const pat of leavePatterns) {
        const m = fullText.match(pat);
        if (m && m[1].trim().length > 0 && m[1].trim().length < 50) {
          msgType = 'leave';
          if (!userName) userName = m[1].trim();
          message = '';
          break;
        }
      }
    }

    // System — DOM要素ベース
    if (
      !userName &&
      msgType === 'chat' &&
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

    // ユーザー名もメッセージも取れなかったら無視（goal/system は除外）
    if (!userName && msgType === 'chat') return null;

    // ユーザーリスト誤認ガード:
    // chatタイプで以下のパターンはユーザーリスト項目の可能性大 → 除外
    if (msgType === 'chat') {
      // (1) メッセージが空 or メッセージ=ユーザー名
      if (!message || message === userName) {
        return null;
      }
      // (2) メッセージが数字のみ（1-3桁）→ DOMランキング番号の残骸
      if (/^\d{1,3}$/.test(message)) {
        return null;
      }
      // (3) fullText全体がユーザー名と同一（数字プレフィックス除去後に一致する場合も含む）
      if (fullText === userName || fullText.replace(/^\d{1,3}/, '') === userName) {
        return null;
      }
    }

    // Final validation — safety net before returning
    const result = validateTipBeforeSave({
      user_name: userName,
      message: message || null,
      msg_type: msgType,
      tokens,
      is_vip: isVip,
      user_color: userColor,
      user_league: userLeague,
      user_level: userLevel,
      metadata: { source: 'dom_observer' },
    });

    return result;
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  // ============================================================
  // Recursive message parser — ラッパーノード対応
  // 1ノード = 1メッセージを保証。ラッパーなら子要素を再帰走査。
  // ============================================================
  function parseOneOrMany(node, depth) {
    if (!depth) depth = 0;
    if (depth > 5) return []; // 安全弁: 再帰上限
    if (node.nodeType !== 1) return [];
    if (node.dataset?.lsParsed) return [];

    // まず単一メッセージとしてパース試行
    const single = parseMessageNode(node);
    if (single) return [single];

    // parseMessageNode が null を返した。
    // lsParsed がセットされていれば「拒否」→ 再帰不要
    if (node.dataset?.lsParsed) return [];

    // lsParsed 未セット = multi-message wrapper → 子要素を再帰処理
    const results = [];
    for (const child of node.children) {
      results.push(...parseOneOrMany(child, depth + 1));
    }
    // ラッパー自体を処理済みマーク（再処理防止）
    if (results.length > 0) {
      node.dataset.lsParsed = '1';
    }
    return results;
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

    // 初回スキャンをスキップ — リアルタイム新規メッセージのみ取得
    // 理由: 既存メッセージの一括取得でテキスト連結バグが発生するため
    // MutationObserver が正常動作しているので、監視開始後の新規メッセージだけで十分
    console.log(LOG, '初回スキャンをスキップ、MutationObserverのみで監視開始');

    // 配信タイトル初回チェック（少し遅延させてDOM安定を待つ）
    setTimeout(checkBroadcastTitle, 3000);

    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      let newMsgCount = 0;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          const parsedList = parseOneOrMany(node);
          for (const parsed of parsedList) {
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
  // Window Message Relay: フロントエンド → background.js
  // ============================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'LS_OPEN_ALL_SPY_TABS') {
      console.log(LOG, 'LS_OPEN_ALL_SPY_TABS受信 → background.jsへ転送', event.data.castNames?.length, 'キャスト');
      chrome.runtime.sendMessage(
        { type: 'OPEN_ALL_SPY_TABS', castNames: event.data.castNames || [] },
        (response) => {
          window.postMessage({ type: 'LS_OPEN_ALL_SPY_TABS_RESULT', ...response }, '*');
        }
      );
    }
  });

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
  // 視聴者パネル内訳取得（CVR分析用）
  // ============================================================
  // NOTE: viewer panel (.model-chat-users-info) はユーザーが一度パネルを
  // 開かないとDOMに出現しない場合がある。自動クリックは将来タスクとして保留。

  /**
   * extractViewerPanelInfo()
   * Stripchat の視聴者パネル DOM から内訳を抽出する。
   * - total_viewers: 「Xが見ています」の数値
   * - ultimate_count: アルティメット会員数 (.info-item-ultimate)
   * - coin_holders: コイン有りユーザー数 (.info-item-grey の1番目)
   * - others_count: その他の視聴者数
   *
   * パネルが閉じている等でDOMが存在しない場合は全てnullを返す。
   */
  function extractViewerPanelInfo() {
    const result = {
      total_viewers: null,
      ultimate_count: null,
      coin_holders: null,
      others_count: null,
    };

    try {
      // 合計視聴者数
      const totalEl = document.querySelector('div.model-chat-users-info-watching-now');
      if (totalEl) {
        const m = (totalEl.textContent || '').match(/(\d+)/);
        if (m) result.total_viewers = parseInt(m[1], 10);
      }

      // アルティメット会員数
      const ultimateEl = document.querySelector('div.model-chat-users-info-item span.info-item-ultimate');
      if (ultimateEl) {
        const m = (ultimateEl.textContent || '').match(/(\d+)/);
        if (m) result.ultimate_count = parseInt(m[1], 10);
      }

      // コイン有りユーザー数（info-item-grey の1番目）
      const greyItems = document.querySelectorAll('div.model-chat-users-info-item span.info-item-grey');
      if (greyItems.length >= 1) {
        const m = (greyItems[0].textContent || '').match(/(\d+)/);
        if (m) result.coin_holders = parseInt(m[1], 10);
      }

      // その他の視聴者数
      // 方法1: info-item-grey の2番目（DOMに存在する場合）
      if (greyItems.length >= 2) {
        const m = (greyItems[1].textContent || '').match(/(\d+)/);
        if (m) result.others_count = parseInt(m[1], 10);
      }
      // 方法2: DOM に2番目がなければ total - ultimate - coin_holders で算出
      if (result.others_count === null && result.total_viewers !== null) {
        const ult = result.ultimate_count || 0;
        const coin = result.coin_holders || 0;
        const calc = result.total_viewers - ult - coin;
        if (calc >= 0) result.others_count = calc;
      }
    } catch (e) {
      // DOM not ready yet — return all nulls
    }

    return result;
  }

  // ============================================================
  // 視聴者数カウント取得
  // ============================================================
  let lastViewerStats = null;
  let viewerStatsTimer = null;

  function getViewerStats() {
    try {
      // 視聴者パネル内訳を取得（アルティメット/コイン有り/その他）
      const panelInfo = extractViewerPanelInfo();

      const total = panelInfo.total_viewers;
      // 後方互換: coin_users は panelInfo.coin_holders、others は panelInfo.others_count
      const coinUsers = panelInfo.coin_holders;
      const others = panelInfo.others_count;

      if (total === null && coinUsers === null) {
        console.log(LOG, 'viewer_stats: DOMセレクタでヒットなし — スキップ');
        return;
      }

      const stats = {
        total,
        coin_users: coinUsers,
        others,
        ultimate_count: panelInfo.ultimate_count,
        coin_holders: panelInfo.coin_holders,
        others_count: panelInfo.others_count,
      };
      const key = `${stats.total}:${stats.coin_users}:${stats.others}:${stats.ultimate_count}:${stats.coin_holders}:${stats.others_count}`;
      const lastKey = lastViewerStats
        ? `${lastViewerStats.total}:${lastViewerStats.coin_users}:${lastViewerStats.others}:${lastViewerStats.ultimate_count}:${lastViewerStats.coin_holders}:${lastViewerStats.others_count}`
        : null;

      if (key !== lastKey) {
        const prevTotal = lastViewerStats ? lastViewerStats.total : null;
        const delta = (prevTotal !== null && stats.total !== null) ? stats.total - prevTotal : 0;

        lastViewerStats = stats;

        // 1. 既存フロー: viewer_stats テーブルへ（新カラム含む）
        chrome.runtime.sendMessage({
          type: 'VIEWER_STATS',
          cast_name: castName,
          total: stats.total,
          coin_users: stats.coin_users,
          others: stats.others,
          ultimate_count: stats.ultimate_count,
          coin_holders: stats.coin_holders,
          others_count: stats.others_count,
          timestamp: new Date().toISOString(),
        });

        // 2. NEW: spy_messages タイムラインにも統合（初回は差分不明なのでスキップ）
        if (prevTotal !== null) {
          const trend = delta > 5 ? '▲ 急増' : delta > 0 ? '▲ 増加' : delta < -5 ? '▼ 急減' : delta < 0 ? '▼ 減少' : '━ 横ばい';
          const ultLabel = stats.ultimate_count !== null ? ` ULT:${stats.ultimate_count}` : '';
          const coinLabel = stats.coin_holders !== null ? ` COIN:${stats.coin_holders}` : '';
          chrome.runtime.sendMessage({
            type: 'CHAT_MESSAGE',
            cast_name: castName,
            message_time: new Date().toISOString(),
            msg_type: 'viewer_count',
            user_name: null,
            message: `視聴者数: ${prevTotal}→${stats.total} (${delta >= 0 ? '+' : ''}${delta}) ${trend}${ultLabel}${coinLabel}`,
            tokens: 0,
            is_vip: false,
            user_color: null,
            metadata: {
              source: 'viewer_stats',
              total: stats.total,
              coin_users: stats.coin_users,
              others: stats.others,
              ultimate_count: stats.ultimate_count,
              coin_holders: stats.coin_holders,
              others_count: stats.others_count,
              delta,
            },
          });
        }

        console.log(LOG, `viewer_stats: ${stats.total} viewers (ULT:${stats.ultimate_count ?? '-'} COIN:${stats.coin_holders ?? '-'} OTHER:${stats.others_count ?? '-'}) for ${castName}`, delta !== 0 ? `(${delta >= 0 ? '+' : ''}${delta})` : '');
      }
    } catch (e) {
      // DOM not ready yet
    }
  }

  function startViewerStatsPolling() {
    if (viewerStatsTimer) return;
    getViewerStats();
    checkBroadcastTitle(); // 配信タイトルもチェック
    viewerStatsTimer = setInterval(() => {
      getViewerStats();
      checkBroadcastTitle(); // 定期的に配信タイトルの変更をチェック
    }, 180000);
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
  // Profile & Feed Extraction (Task B)
  // ============================================================

  /**
   * extractProfileInfo()
   * Stripchat のプロフィールページ（/username のメインページ）から情報を抽出。
   * - .field-row 要素からキーバリューペアを取得
   * - .profile-panel-body からバイオテキスト
   * - .profile-tip-menu__activity からチップメニュー項目
   * - エピックゴール情報
   * 抽出後 CAST_PROFILE メッセージを background.js に送信
   */
  function extractProfileInfo() {
    const profileCastName = extractCastName();
    if (!profileCastName) {
      console.log(LOG, 'プロフィール抽出: キャスト名取得できず');
      return;
    }

    console.log(LOG, 'プロフィール抽出開始:', profileCastName);

    const profile = {
      cast_name: profileCastName,
      age: null,
      origin: null,
      body_type: null,
      details: null,
      ethnicity: null,
      hair_color: null,
      eye_color: null,
      bio: null,
      followers_count: null,
      tip_menu: null,
      epic_goal: null,
      profile_data: {},
    };

    try {
      // Field rows — key/value pairs in profile details
      const fieldRows = document.querySelectorAll('.field-row, [class*="field-row"]');
      for (const row of fieldRows) {
        const label = row.querySelector('.field-row__label, [class*="label"]');
        const value = row.querySelector('.field-row__value, [class*="value"]');
        if (label && value) {
          const key = (label.textContent || '').trim().toLowerCase();
          const val = (value.textContent || '').trim();
          if (!val) continue;

          profile.profile_data[key] = val;

          // Map known fields
          if (key.includes('age') || key.includes('年齢')) {
            const ageMatch = val.match(/(\d+)/);
            if (ageMatch) profile.age = parseInt(ageMatch[1], 10);
          } else if (key.includes('from') || key.includes('出身') || key.includes('origin') || key.includes('country')) {
            profile.origin = val;
          } else if (key.includes('body') || key.includes('体型')) {
            profile.body_type = val;
          } else if (key.includes('detail') || key.includes('特徴')) {
            profile.details = val;
          } else if (key.includes('ethnicity') || key.includes('民族')) {
            profile.ethnicity = val;
          } else if (key.includes('hair') || key.includes('髪')) {
            profile.hair_color = val;
          } else if (key.includes('eye') || key.includes('目')) {
            profile.eye_color = val;
          }
        }
      }

      // Age from specific selector
      if (!profile.age) {
        const ageEl = document.querySelector('.field-row--age span, [class*="field-row--age"] span');
        if (ageEl) {
          const ageMatch = (ageEl.textContent || '').match(/(\d+)/);
          if (ageMatch) profile.age = parseInt(ageMatch[1], 10);
        }
      }

      // Bio text
      const bioEl = document.querySelector('.profile-panel-body, [class*="profile-panel-body"], .bio-text, [class*="bio"]');
      if (bioEl) {
        profile.bio = (bioEl.textContent || '').trim().substring(0, 2000);
      }

      // Followers count
      const followEl = document.querySelector('[class*="followers"] [class*="count"], [class*="follower-count"]');
      if (followEl) {
        profile.followers_count = (followEl.textContent || '').trim();
      }

      // Tip menu
      const tipMenuItems = document.querySelectorAll('.profile-tip-menu__activity, [class*="tip-menu"] [class*="activity"], [class*="tipMenu"] [class*="item"]');
      if (tipMenuItems.length > 0) {
        const tipMenu = [];
        for (const item of tipMenuItems) {
          const nameEl = item.querySelector('[class*="name"], [class*="label"], [class*="text"]');
          const coinsEl = item.querySelector('[class*="coin"], [class*="price"], [class*="amount"]');
          const name = nameEl ? (nameEl.textContent || '').trim() : (item.textContent || '').trim();
          const coinsMatch = coinsEl
            ? (coinsEl.textContent || '').match(/(\d+)/)
            : (item.textContent || '').match(/(\d+)/);
          tipMenu.push({
            name: name,
            coins: coinsMatch ? parseInt(coinsMatch[1], 10) : 0,
          });
        }
        if (tipMenu.length > 0) profile.tip_menu = tipMenu;
      }

      // Epic goal
      const goalEl = document.querySelector('[class*="epic-goal"], [class*="epicGoal"], [class*="goal-progress"]');
      if (goalEl) {
        const goalText = (goalEl.textContent || '').trim();
        const currentMatch = goalText.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
        profile.epic_goal = {
          text: goalText.substring(0, 500),
          current: currentMatch ? parseInt(currentMatch[1].replace(/,/g, ''), 10) : null,
          target: currentMatch ? parseInt(currentMatch[2].replace(/,/g, ''), 10) : null,
        };
      }
    } catch (e) {
      console.warn(LOG, 'プロフィール抽出エラー:', e.message);
    }

    // Send to background.js
    console.log(LOG, 'プロフィール抽出完了:', profileCastName, 'fields:', Object.keys(profile.profile_data).length);
    try {
      chrome.runtime.sendMessage({
        type: 'CAST_PROFILE',
        cast_name: profileCastName,
        profile: profile,
      });
    } catch (e) {
      console.warn(LOG, 'プロフィール送信失敗:', e.message);
    }
  }

  /**
   * extractFeedPosts()
   * Stripchat のタイムラインページ（/username/timeline等）からフィード投稿を抽出。
   * - .feed-post 要素
   * - .text でポストテキスト, .tile-header で日付, .likes-counter でいいね数
   * - img の存在で画像有無
   * 抽出後 CAST_FEED メッセージを background.js に送信
   */
  function extractFeedPosts() {
    const feedCastName = extractCastName();
    if (!feedCastName) {
      console.log(LOG, 'フィード抽出: キャスト名取得できず');
      return;
    }

    console.log(LOG, 'フィード抽出開始:', feedCastName);

    const posts = [];
    try {
      const feedElements = document.querySelectorAll(
        '.feed-post, [class*="feed-post"], [class*="feedPost"], [class*="timeline-post"], [class*="timelinePost"]'
      );

      for (const postEl of feedElements) {
        const textEl = postEl.querySelector('.text, [class*="post-text"], [class*="postText"], [class*="content"]');
        const dateEl = postEl.querySelector('.tile-header, [class*="tile-header"], [class*="date"], [class*="time"], time');
        const likesEl = postEl.querySelector('.likes-counter, [class*="likes-counter"], [class*="likesCounter"], [class*="like-count"]');
        const hasImage = !!postEl.querySelector('img, video, [class*="media"]');

        const postText = textEl ? (textEl.textContent || '').trim().substring(0, 2000) : '';
        const postDate = dateEl
          ? (dateEl.getAttribute('datetime') || dateEl.textContent || '').trim()
          : '';
        const likesMatch = likesEl ? (likesEl.textContent || '').match(/(\d+)/) : null;
        const likesCount = likesMatch ? parseInt(likesMatch[1], 10) : 0;

        if (postText || postDate) {
          posts.push({
            post_text: postText || null,
            post_date: postDate || null,
            likes_count: likesCount,
            has_image: hasImage,
          });
        }
      }
    } catch (e) {
      console.warn(LOG, 'フィード抽出エラー:', e.message);
    }

    if (posts.length === 0) {
      console.log(LOG, 'フィード抽出: 投稿なし');
      return;
    }

    console.log(LOG, 'フィード抽出完了:', feedCastName, '投稿数:', posts.length);
    try {
      chrome.runtime.sendMessage({
        type: 'CAST_FEED',
        cast_name: feedCastName,
        posts: posts,
      });
    } catch (e) {
      console.warn(LOG, 'フィード送信失敗:', e.message);
    }
  }

  /**
   * URL based page type detection — profile/timeline extraction
   * チャットページ以外のプロフィール/タイムラインページで自動実行
   */
  function checkPageTypeAndExtract() {
    const path = window.location.pathname;

    // Profile page: /username (main profile page with no sub-path, or explicit /profile)
    // timeline/feed: /username/timeline or /username/feed
    if (/\/[^/]+\/timeline\b/i.test(path) || /\/[^/]+\/feed\b/i.test(path)) {
      console.log(LOG, 'タイムラインページ検出 → フィード抽出');
      setTimeout(extractFeedPosts, 3000); // DOM安定待ち
    } else if (/\/[^/]+\/profile\b/i.test(path)) {
      console.log(LOG, 'プロフィールページ検出 → プロフィール抽出');
      setTimeout(extractProfileInfo, 3000);
    }
    // Note: main cast page (/username) is for chat monitoring, not profile extraction.
    // Profile extraction only runs on explicit /username/profile pages.
  }

  // ============================================================
  // 初期化
  // ============================================================
  console.log(LOG, '=== Content SPYスクリプト読込 === URL:', location.href);

  // Profile/Feed extraction — SPY有効無効に関係なくページ種別に応じて実行
  if (document.readyState === 'complete') {
    checkPageTypeAndExtract();
  } else {
    window.addEventListener('load', checkPageTypeAndExtract);
  }

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
