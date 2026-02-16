/**
 * Strip Live Spot - DM Executor v3
 * Background から SEND_DM メッセージを受け取りStripchat上でDM送信を実行
 *
 * フロー:
 *   background.js がタブをプロフィールURLへ遷移させる
 *   → ページロード完了後に本スクリプトが注入される
 *   → SEND_DM メッセージを受信
 *   → プロフィール内の「PMを送る」ボタンをクリック
 *   → DMダイアログでメッセージ入力 → 送信 → 結果報告
 *
 * 重要: ヘッダーナビの「メッセージ一覧」アイコンを押さないこと！
 *   ❌ header/nav 内のメッセージアイコン → サイト全体のメッセージ一覧
 *   ✅ プロフィール本体内の「PMを送る」ボタン → 個別DMダイアログ
 */

(function () {
  'use strict';

  const LOG = '[LS-DM]';

  // ============================================================
  // DOM Helpers
  // ============================================================
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForElement(testFn, timeout = 8000) {
    return new Promise((resolve) => {
      const found = testFn();
      if (found) { resolve(found); return; }

      const obs = new MutationObserver(() => {
        const el = testFn();
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // ============================================================
  // ヘッダー/ナビ内の要素かどうか判定
  // ============================================================
  function isInHeaderOrNav(el) {
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName?.toLowerCase();
      if (tag === 'header' || tag === 'nav') return true;

      const cls = (node.className || '').toString().toLowerCase();
      // ヘッダー/ナビバー/トップバーに相当するクラス
      if (/\b(header|navbar|nav-bar|top-bar|topbar|site-header|main-header|navigation)\b/.test(cls)) {
        return true;
      }
      // Stripchat固有: ヘッダー内のユーティリティバー
      if (/\b(header-|Header|HeaderMenu|headerMenu)\b/.test(cls)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // ============================================================
  // プロフィール内の「PMを送る」ボタンを探す
  // ============================================================
  async function findPMButton() {
    // 全ボタン/リンクを取得
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    const scored = [];

    for (const el of candidates) {
      // ヘッダー/ナビ内は除外
      if (isInHeaderOrNav(el)) continue;
      // form内のsubmitボタンは除外
      if (el.closest('form')) continue;
      // チャット入力欄周辺の送信ボタンは除外
      if (el.closest('[class*="chat-input"], [class*="chatInput"], [class*="ChatInput"]')) continue;

      const text = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const title = el.title || '';
      const cls = (el.className || '').toString();
      const href = el.getAttribute('href') || '';
      const allText = `${text}|${aria}|${title}|${cls}|${href}`.toLowerCase();

      let score = 0;

      // === 高スコア: PMを直接示す表現 ===

      // "PMを送る" (日本語) — 最優先
      if (/pmを送/.test(text.toLowerCase())) score += 100;
      // "Send PM" / "Send a PM" (英語)
      if (/send\s*(a\s*)?pm/i.test(text)) score += 100;
      // "PM" が単独テキスト（2-3文字のボタン）
      if (/^\s*PM\s*$/i.test(text)) score += 90;
      // "Write PM" / "PM送信"
      if (/write\s*pm|pm送信|pm\s*送/i.test(allText)) score += 90;

      // === 中スコア: PM関連のclass/属性 ===

      // class/属性に "pm" を含む（ただし "rpm" "npm" 等を除外）
      if (/\bpm\b|send-pm|sendPm|SendPM|pm-button|pmButton/i.test(cls)) score += 70;
      // data属性に pm を含む
      if (el.getAttribute('data-test-id')?.toLowerCase().includes('pm')) score += 80;
      if (el.getAttribute('data-testid')?.toLowerCase().includes('pm')) score += 80;

      // === 低スコア: メッセージ関連（PMではないが候補になりうる） ===

      // "メッセージを送る" / "Send Message" — プロフィール内ならPMボタンの可能性
      if (/メッセージを送|send\s*message/i.test(text)) score += 40;
      // "メッセージ" 単独（短い場合のみ、長文は除外）
      if (/^.{0,10}メッセージ.{0,10}$/.test(text) && text.length <= 20) score += 20;
      if (/^.{0,10}message.{0,10}$/i.test(text) && text.length <= 20) score += 20;

      // class に message を含む（ヘッダー除外済み）
      if (/send-message|sendMessage|SendMessage|message-button|messageButton/i.test(cls)) score += 30;

      // href が /messages/ を含む + ユーザー名を含むなら個別DM
      if (/\/messages\//.test(href)) {
        score += 15;
      }

      // === スコア補正 ===

      // プロフィールエリア内にある要素にボーナス
      const parentClasses = getAncestorClasses(el, 5);
      if (/profile|Profile|user-info|userInfo|UserInfo|model-info|modelInfo/.test(parentClasses)) {
        score += 20;
      }
      // メインコンテンツエリア内にある要素にボーナス
      if (/main|content|page|body/i.test(parentClasses)) {
        score += 5;
      }

      if (score > 0) {
        scored.push({ el, score, text: text.substring(0, 40), cls: cls.substring(0, 60) });
      }
    }

    // スコア順にソート
    scored.sort((a, b) => b.score - a.score);

    // デバッグ: 上位候補をログ出力
    if (scored.length > 0) {
      console.log(LOG, 'PMボタン候補:', scored.slice(0, 5).map(s =>
        `score=${s.score} text="${s.text}" cls="${s.cls}"`
      ));
    } else {
      console.warn(LOG, 'PMボタン候補なし — DOM内のボタン総数:', candidates.length);
      // デバッグ: ヘッダー外の全ボタンをリスト
      const nonHeaderBtns = Array.from(candidates).filter(el => !isInHeaderOrNav(el));
      console.log(LOG, 'ヘッダー外ボタン:', nonHeaderBtns.length, '件');
      nonHeaderBtns.slice(0, 10).forEach(el => {
        console.log(LOG, '  -', el.tagName, `text="${(el.textContent || '').trim().substring(0, 30)}"`,
          `class="${(el.className || '').toString().substring(0, 50)}"`);
      });
    }

    return scored.length > 0 ? scored[0].el : null;
  }

  /**
   * 祖先要素のclass名を連結して返す（最大depth階層）
   */
  function getAncestorClasses(el, depth) {
    const classes = [];
    let node = el.parentElement;
    for (let i = 0; i < depth && node && node !== document.body; i++) {
      if (node.className) classes.push(node.className.toString());
      node = node.parentElement;
    }
    return classes.join(' ');
  }

  // ============================================================
  // DMダイアログを開く
  // ============================================================
  async function openDMDialog() {
    console.log(LOG, 'PMボタン検索開始...');

    // まず即座に検索
    let pmBtn = await findPMButton();

    // 見つからない場合はDOMの遅延読み込みを待つ（最大5秒）
    if (!pmBtn) {
      console.log(LOG, 'PMボタン未発見 → DOM安定待ち (5秒)...');
      pmBtn = await waitForElement(() => findPMButtonSync(), 5000);
    }

    if (!pmBtn) {
      console.error(LOG, 'PMボタンが見つかりません。プロフィールページか確認してください。');
      console.log(LOG, 'URL:', window.location.href);
      return false;
    }

    console.log(LOG, 'PMボタン発見! クリック:',
      `tag=${pmBtn.tagName}`,
      `text="${(pmBtn.textContent || '').trim().substring(0, 30)}"`,
      `class="${(pmBtn.className || '').toString().substring(0, 60)}"`
    );

    pmBtn.click();

    // ダイアログが開くのを待つ
    await sleep(2500);
    return true;
  }

  /**
   * findPMButton の同期版（waitForElement用）
   */
  function findPMButtonSync() {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      if (isInHeaderOrNav(el)) continue;
      if (el.closest('form')) continue;

      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();

      // PM関連のテキスト
      if (/pmを送|send\s*(a\s*)?pm|write\s*pm|pm送信/i.test(text)) return el;
      if (/^\s*pm\s*$/i.test(text)) return el;
      // PM関連のclass
      if (/\bpm\b|send-pm|sendpm|pm-button|pmbutton/i.test(cls)) return el;
      // data属性
      if (el.getAttribute('data-test-id')?.toLowerCase().includes('pm')) return el;
      if (el.getAttribute('data-testid')?.toLowerCase().includes('pm')) return el;
    }
    return null;
  }

  // ============================================================
  // DM入力欄を探す
  // ============================================================
  async function findDMInput() {
    console.log(LOG, 'DM入力欄検索開始...');

    // Strategy 1: モーダル/ダイアログ内の入力欄を優先検索
    // （PMボタンクリック後に開くダイアログ）
    const modalSelectors = [
      '[role="dialog"]',
      '[class*="modal" i]', '[class*="Modal"]',
      '[class*="dialog" i]', '[class*="Dialog"]',
      '[class*="popup" i]', '[class*="Popup"]',
      '[class*="overlay" i]',
      '[class*="messenger" i]', '[class*="Messenger"]',
      '[class*="private-message" i]', '[class*="PrivateMessage"]',
      '[class*="dm-" i]', '[class*="Dm"]',
    ];

    for (const mSel of modalSelectors) {
      try {
        const modal = document.querySelector(mSel);
        if (!modal) continue;
        // textarea優先
        const textarea = modal.querySelector('textarea');
        if (textarea) {
          console.log(LOG, 'DM入力欄発見 (modal textarea):', mSel);
          return textarea;
        }
        // contentEditable
        const editable = modal.querySelector('[contenteditable="true"]');
        if (editable) {
          console.log(LOG, 'DM入力欄発見 (modal contentEditable):', mSel);
          return editable;
        }
        // input[type=text]
        const input = modal.querySelector('input[type="text"]');
        if (input) {
          console.log(LOG, 'DM入力欄発見 (modal input):', mSel);
          return input;
        }
      } catch (e) { /* invalid selector, skip */ }
    }

    // Strategy 2: 直接セレクタで検索
    const inputSelectors = [
      '[data-testid="dm-input"]',
      '[data-test-id="dm-input"]',
      'textarea[class*="message" i]',
      'textarea[class*="Message"]',
      '[class*="dmInput"]', '[class*="DmInput"]', '[class*="dm-input"]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="メッセージ"]',
      'textarea[placeholder*="Write" i]',
      '[contenteditable="true"][class*="message" i]',
      '[contenteditable="true"][class*="input" i]',
    ];

    for (const sel of inputSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          console.log(LOG, 'DM入力欄発見 (直接):', sel);
          return el;
        }
      } catch (e) { /* invalid selector */ }
    }

    // Strategy 3: 最大5秒間DOMの出現を待つ
    console.log(LOG, 'DM入力欄未発見 → DOM出現待ち (5秒)...');
    const found = await waitForElement(() => {
      for (const mSel of modalSelectors) {
        try {
          const modal = document.querySelector(mSel);
          if (!modal) continue;
          const ta = modal.querySelector('textarea');
          if (ta) return ta;
          const ce = modal.querySelector('[contenteditable="true"]');
          if (ce) return ce;
          const inp = modal.querySelector('input[type="text"]');
          if (inp) return inp;
        } catch (e) { /* skip */ }
      }
      return null;
    }, 5000);

    if (found) {
      console.log(LOG, 'DM入力欄発見 (待機後):', found.tagName);
    } else {
      console.error(LOG, 'DM入力欄が見つかりません');
      // デバッグ: ページ上の全textarea/input をリスト
      const allInputs = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
      console.log(LOG, 'ページ上の入力要素:', allInputs.length, '件');
      Array.from(allInputs).slice(0, 10).forEach(el => {
        console.log(LOG, '  -', el.tagName,
          `class="${(el.className || '').toString().substring(0, 40)}"`,
          `placeholder="${el.placeholder || ''}"`,
          `inHeader=${isInHeaderOrNav(el)}`);
      });
    }

    return found;
  }

  // ============================================================
  // メッセージ入力（React controlled input対応）
  // ============================================================
  async function simulateTyping(element, text) {
    element.focus();
    element.click();
    await sleep(100);

    // contentEditable 対応
    if (element.contentEditable === 'true' || element.getAttribute('contenteditable') === 'true') {
      console.log(LOG, 'contentEditable入力モード');
      element.textContent = '';
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      await sleep(300);
      return;
    }

    // React controlled input: native setter で値をセット
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;

    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, text);
    } else {
      element.value = text;
    }

    // React が検知するイベントをdispatch
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(300);
  }

  // ============================================================
  // 送信ボタンを探してクリック
  // ============================================================
  function findSendButton(nearElement) {
    // 入力欄の親コンテナ（モーダル/フォーム/ダイアログ）を探す
    const container =
      nearElement.closest('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="messenger" i], [class*="private-message" i], form')
      || nearElement.closest('[class*="message" i]')
      || nearElement.parentElement?.parentElement?.parentElement
      || nearElement.parentElement?.parentElement
      || nearElement.parentElement;

    if (!container) {
      console.warn(LOG, '送信ボタン: コンテナが見つからない');
      return null;
    }

    console.log(LOG, '送信ボタン検索: コンテナ=', container.tagName,
      `class="${(container.className || '').toString().substring(0, 50)}"`);

    // 優先順位付きで検索
    const selectors = [
      'button[type="submit"]',
      'button[class*="send" i]',
      '[data-testid="send-button"]',
      '[data-test-id="send-button"]',
      'button[title*="Send" i]',
      'button[title*="送信"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="送信"]',
    ];

    for (const sel of selectors) {
      try {
        const btn = container.querySelector(sel);
        if (btn) {
          console.log(LOG, '送信ボタン発見 (セレクタ):', sel);
          return btn;
        }
      } catch (e) { /* skip */ }
    }

    // テキストから判定
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      const title = (btn.title || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        text.includes('send') || text.includes('送信') ||
        title.includes('send') || title.includes('送信') ||
        aria.includes('send') || aria.includes('送信')
      ) {
        console.log(LOG, '送信ボタン発見 (テキスト):', text.substring(0, 20));
        return btn;
      }
    }

    // SVGアイコンのみの送信ボタン（矢印アイコン等）
    for (const btn of buttons) {
      if (btn.querySelector('svg') && !(btn.textContent || '').trim()) {
        console.log(LOG, '送信ボタン発見 (SVGアイコン)');
        return btn;
      }
    }

    console.warn(LOG, '送信ボタンが見つからない。コンテナ内ボタン数:', buttons.length);
    return null;
  }

  // ============================================================
  // DM送信メインフロー
  // ============================================================
  async function executeDM(username, message) {
    console.log(LOG, '========================================');
    console.log(LOG, `DM送信開始: ${username}`);
    console.log(LOG, `URL: ${window.location.href}`);
    console.log(LOG, `メッセージ: "${message.substring(0, 50)}..."`);

    try {
      // Step 1: プロフィール内のPMボタンをクリック
      console.log(LOG, 'Step 1: PMボタン検索...');
      const dialogOpened = await openDMDialog();
      if (!dialogOpened) {
        throw new Error('PMボタンが見つかりません。プロフィールページか確認してください。');
      }

      // Step 2: DM入力欄を探す
      console.log(LOG, 'Step 2: DM入力欄検索...');
      const dmInput = await findDMInput();
      if (!dmInput) {
        throw new Error('DM入力欄が見つかりません。ダイアログが正しく開いたか確認してください。');
      }

      // Step 3: メッセージを入力
      console.log(LOG, 'Step 3: メッセージ入力...');
      await simulateTyping(dmInput, message);
      await sleep(500);

      // Step 4: 送信ボタンを探してクリック
      console.log(LOG, 'Step 4: 送信...');
      const sendBtn = findSendButton(dmInput);
      if (!sendBtn) {
        // Enter キーでの送信を試行
        console.log(LOG, '送信ボタン未検出 → Enterキー送信を試行');
        dmInput.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        await sleep(300);
        dmInput.dispatchEvent(new KeyboardEvent('keypress', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        await sleep(300);
        dmInput.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
      } else {
        sendBtn.click();
      }

      await sleep(2000);

      // Step 5: 送信確認
      const remaining = dmInput.value || dmInput.textContent || '';
      if (remaining.trim() === message.trim()) {
        console.warn(LOG, '入力欄がクリアされていない → 送信失敗の可能性');
        throw new Error('メッセージが送信されなかった可能性があります');
      }

      console.log(LOG, `DM送信成功: ${username}`);
      console.log(LOG, '========================================');
      return { success: true, error: null };
    } catch (err) {
      console.error(LOG, `DM送信失敗 (${username}):`, err.message);
      console.log(LOG, '========================================');
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // Message Handler
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SEND_DM') {
      console.log(LOG, `SEND_DM受信: user=${msg.username}, taskId=${msg.taskId}`);

      executeDM(msg.username, msg.message).then((result) => {
        // 結果を background.js に送信
        chrome.runtime.sendMessage({
          type: 'DM_SEND_RESULT',
          taskId: msg.taskId,
          success: result.success,
          error: result.error,
        });
        sendResponse({ ok: true, result });
      });

      return true; // 非同期レスポンス
    }

    // レガシー: EXECUTE_DM（旧フォーマット、互換性維持）
    if (msg.type === 'EXECUTE_DM') {
      console.log(LOG, `EXECUTE_DM受信 (レガシー): ${msg.tasks?.length || 0} tasks`);
      sendResponse({ ok: true, queued: 0, message: 'Use SEND_DM instead' });
      return false;
    }
  });

  console.log(LOG, 'DM executor ready (v3)');
})();
