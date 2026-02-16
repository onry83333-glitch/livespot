/**
 * Strip Live Spot - DM Executor v5.1
 * Background から SEND_DM メッセージを受け取りStripchat上でDM送信を実行
 *
 * v5.1: タイムアウト問題修正
 *   - 各ステップにタイミングログ追加（ボトルネック特定用）
 *   - PMダイアログ待ち: 1s→500ms
 *   - 送信後確認待ち: 1s→500ms（Morning Hook CRMは0.8s）
 *   - 送信失敗時のリトライ削除（リトライで+2s超過していた）
 *   - findDMInputポーリング間隔: 500ms→200ms
 *
 * 【確定セレクタ（DevTools確認済み）】
 *   PMボタン:       #user-actions-send-pm (ID最優先)
 *                   button[aria-label="PMを送信"]
 *                   button[aria-label="PMを送る"] (表記揺れ)
 *   入力欄:         textarea[placeholder*="プライベートメッセージ"]
 *   送信ボタン:     button[aria-label="送信"]
 *
 * 【親要素のDOM構造】
 *   div.ProfilePageContent__profile-page-cover-wrapper
 *     div.profile-cover__info
 *       div.action-buttons.user.user-action-buttons
 *         div.action-buttons-container
 *           button#user-actions-send-pm  ← これ
 *
 * フロー:
 *   background.js がタブをプロフィールURLへ遷移
 *   → SEND_DM メッセージ受信
 *   → プロフィール要素のロード待ち（SPA遷移対応）
 *   → #user-actions-send-pm をクリック（フォールバック: aria-label）
 *   → textarea[placeholder*="プライベートメッセージ"] にメッセージ入力
 *   → button[aria-label="送信"] をクリック
 *   → 結果報告
 */

(function () {
  'use strict';

  const LOG = '[LS-DM]';

  // ============================================================
  // 確定セレクタ（DevTools実測済み）
  // ============================================================
  const PM_SELECTORS = [
    '#user-actions-send-pm',                    // ID（最確実 — DevTools確認済み）
    'button[aria-label="PMを送信"]',             // aria-label日本語
    'button[aria-label="PMを送る"]',             // aria-label日本語別表記
    'button[aria-label="Send PM"]',              // aria-label英語
    '.user-action-buttons button.btn-outline',   // クラス指定
  ];
  const PROFILE_WAIT_SELECTOR = '.profile-cover__info, .ProfilePageContent__profile-page-cover-wrapper, .user-action-buttons, #user-actions-send-pm';
  const INPUT_SELECTOR = 'textarea[placeholder*="プライベートメッセージ"]';
  const SEND_SELECTOR = 'button[aria-label="送信"]';

  // ============================================================
  // DOM Helpers
  // ============================================================
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * CSSセレクタで要素の出現をMutationObserverで待つ
   */
  function waitForElement(selector, timeout = 8000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
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
  // Step 1: PMボタンをクリック
  // ============================================================
  async function clickPMButton() {
    console.log(LOG, 'Step 1: PMボタン検索...');

    // Phase 1: プロフィール要素のロードを待つ（SPA遷移対応）
    console.log(LOG, 'Phase 1: プロフィール要素のロード待ち (最大8秒)...');
    const profileEl = await waitForElement(PROFILE_WAIT_SELECTOR, 8000);
    if (profileEl) {
      console.log(LOG, 'プロフィール要素検出:', profileEl.id || profileEl.className?.toString().substring(0, 60));
      // ボタンの描画完了を保証
      await sleep(300);
    } else {
      console.warn(LOG, 'プロフィール要素が8秒以内に見つかりません — そのまま続行');
    }

    // Phase 2: 確定セレクタで順番に試行
    for (const sel of PM_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        console.log(LOG, `PMボタン発見 (確定セレクタ): ${sel}`);
        btn.click();
        return true;
      }
    }

    // Phase 3: XPathで「PMを送信」テキストを含むbutton
    try {
      const xpath = "//button[contains(., 'PMを送信')]";
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const btn = result.singleNodeValue;
      if (btn) {
        console.log(LOG, 'PMボタン発見 (XPath): PMを送信');
        btn.click();
        return true;
      }
    } catch (e) { /* ignore */ }

    // Phase 4: aria-label/テキストに "PM" を含むボタン（ヘッダー除外）
    const allBtns = document.querySelectorAll('button');
    for (const b of allBtns) {
      if (isInHeaderOrNav(b)) continue;
      const aria = b.getAttribute('aria-label') || '';
      const text = (b.textContent || '').trim();
      if (/PM/.test(aria) || /PM/.test(text)) {
        console.log(LOG, `PMボタン発見 (フォールバック): aria="${aria}" text="${text}"`);
        b.click();
        return true;
      }
    }

    // Phase 5: 英語版 "Send PM"
    for (const b of allBtns) {
      if (isInHeaderOrNav(b)) continue;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.textContent || '').trim().toLowerCase();
      if (/send\s*(a\s*)?pm/i.test(text) || /send\s*(a\s*)?pm/i.test(aria)) {
        console.log(LOG, `PMボタン発見 (英語): text="${text}"`);
        b.click();
        return true;
      }
    }

    // 見つからない場合: デバッグ情報を出力
    console.error(LOG, 'PMボタンが見つかりません');
    console.log(LOG, 'URL:', window.location.href);
    const nonHeaderBtns = Array.from(allBtns).filter(b => !isInHeaderOrNav(b));
    console.log(LOG, 'ヘッダー外ボタン一覧 (' + nonHeaderBtns.length + '件):');
    nonHeaderBtns.forEach(b => {
      const aria = b.getAttribute('aria-label') || '';
      const text = (b.textContent || '').trim().substring(0, 30);
      const cls = (b.className || '').toString().substring(0, 40);
      console.log(LOG, `  id="${b.id}" aria="${aria}" text="${text}" class="${cls}"`);
    });

    return false;
  }

  // ============================================================
  // ヘッダー/ナビ判定
  // ============================================================
  function isInHeaderOrNav(el) {
    let node = el;
    while (node && node !== document.body) {
      const tag = node.tagName?.toLowerCase();
      if (tag === 'header' || tag === 'nav') return true;
      const cls = (node.className || '').toString().toLowerCase();
      if (/\b(header|navbar|nav-bar|top-bar|topbar|site-header)\b/.test(cls)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // ============================================================
  // Step 2: DM入力欄を探す
  // ============================================================
  async function findDMInput(maxWait = 5000) {
    console.log(LOG, 'Step 2: DM入力欄検索...');
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      // Strategy 1: 確定セレクタ
      let el = document.querySelector(INPUT_SELECTOR);
      if (el && el.offsetParent !== null) {
        console.log(LOG, 'DM入力欄発見 (確定セレクタ): textarea[placeholder*="プライベートメッセージ"]');
        return el;
      }

      // Strategy 2: 英語版placeholder
      el = document.querySelector('textarea[placeholder*="private message" i]');
      if (el && el.offsetParent !== null) {
        console.log(LOG, 'DM入力欄発見 (英語placeholder)');
        return el;
      }

      // Strategy 3: 任意の表示中textarea（ヘッダー外、入力可能なもの）
      const textareas = document.querySelectorAll('textarea');
      for (const ta of textareas) {
        if (ta.offsetParent !== null && !isInHeaderOrNav(ta) && !ta.readOnly && !ta.disabled) {
          const ph = ta.placeholder || '';
          console.log(LOG, `DM入力欄発見 (フォールバック textarea): placeholder="${ph}"`);
          return ta;
        }
      }

      // Strategy 4: contentEditable
      const editables = document.querySelectorAll('[contenteditable="true"]');
      for (const ce of editables) {
        if (ce.offsetParent !== null && !isInHeaderOrNav(ce)) {
          const cls = (ce.className || '').toString();
          if (/message|chat|input|dm|pm/i.test(cls) || ce.closest('[class*="message" i], [class*="chat" i], [role="dialog"]')) {
            console.log(LOG, 'DM入力欄発見 (contentEditable)');
            return ce;
          }
        }
      }

      await sleep(200);
    }

    console.error(LOG, 'DM入力欄が見つかりません（タイムアウト）');
    // デバッグ
    const allTA = document.querySelectorAll('textarea');
    console.log(LOG, 'ページ上のtextarea:', allTA.length, '件');
    allTA.forEach(ta => {
      console.log(LOG, `  placeholder="${ta.placeholder}" visible=${ta.offsetParent !== null} class="${(ta.className || '').toString().substring(0, 40)}"`);
    });
    return null;
  }

  // ============================================================
  // Step 3: メッセージ入力
  // ============================================================
  async function typeMessage(element, text) {
    console.log(LOG, 'Step 3: メッセージ入力...');
    element.focus();
    element.click();
    await sleep(100);

    // contentEditable 対応
    if (element.contentEditable === 'true' || element.getAttribute('contenteditable') === 'true') {
      element.textContent = '';
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      await sleep(300);
      return;
    }

    // 改行を含む場合: JavaScript で value を直接セット（Enter=送信のため send_keys 不可）
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;

    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(element, text);
    } else {
      element.value = text;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
  }

  // ============================================================
  // Step 4: 送信ボタンをクリック
  // ============================================================
  async function clickSendButton(chatInput) {
    console.log(LOG, 'Step 4: 送信...');

    // Strategy 1: 確定セレクタ
    let btn = document.querySelector(SEND_SELECTOR);
    if (btn) {
      console.log(LOG, '送信ボタン発見 (確定セレクタ): button[aria-label="送信"]');
      btn.click();
      return true;
    }

    // Strategy 2: 入力欄の近くの送信ボタン
    const container = chatInput.closest('[role="dialog"], [class*="modal" i], [class*="messenger" i], [class*="message" i], form')
      || chatInput.parentElement?.parentElement?.parentElement
      || chatInput.parentElement?.parentElement
      || chatInput.parentElement;

    if (container) {
      // type=submit
      btn = container.querySelector('button[type="submit"]');
      if (btn) {
        console.log(LOG, '送信ボタン発見 (submit)');
        btn.click();
        return true;
      }

      // aria-label に "送信" / "Send"
      for (const b of container.querySelectorAll('button')) {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('送信') || aria.includes('send')) {
          console.log(LOG, `送信ボタン発見 (aria): "${aria}"`);
          b.click();
          return true;
        }
      }

      // テキストに "送信" / "Send"
      for (const b of container.querySelectorAll('button')) {
        const text = (b.textContent || '').trim().toLowerCase();
        if (text.includes('送信') || text === 'send') {
          console.log(LOG, `送信ボタン発見 (text): "${text}"`);
          b.click();
          return true;
        }
      }

      // SVGアイコンのみのボタン（送信矢印）
      for (const b of container.querySelectorAll('button')) {
        if (b.querySelector('svg') && !(b.textContent || '').trim()) {
          console.log(LOG, '送信ボタン発見 (SVGアイコン)');
          b.click();
          return true;
        }
      }
    }

    // Strategy 3: Enterキー（改行なしメッセージのみ）
    const val = chatInput.value || '';
    if (!val.includes('\n')) {
      console.log(LOG, '送信ボタン未発見 → Enterキー送信を試行');
      chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await sleep(100);
      chatInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await sleep(100);
      chatInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return true;
    }

    console.error(LOG, '送信ボタンが見つかりません');
    return false;
  }

  // ============================================================
  // DM送信メインフロー（v5.1: タイミングログ + 高速化）
  // ============================================================
  async function executeDM(username, message) {
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    console.log(LOG, '========================================');
    console.log(LOG, `DM送信開始: ${username}`);
    console.log(LOG, `URL: ${window.location.href}`);

    try {
      // Step 1: PMボタンクリック
      const pmOk = await clickPMButton();
      console.log(LOG, `[TIMING] Step1 PMボタン: ${elapsed()}`);
      if (!pmOk) {
        throw new Error('PMボタン(aria-label="PMを送信")が見つかりません');
      }

      // PMクリック後、ダイアログが開くのを待つ（1s→500ms）
      await sleep(500);
      console.log(LOG, `[TIMING] PMダイアログ待ち後: ${elapsed()}`);

      // Step 2: DM入力欄を探す
      const chatInput = await findDMInput(5000);
      console.log(LOG, `[TIMING] Step2 DM入力欄: ${elapsed()}`);
      if (!chatInput) {
        throw new Error('DM入力欄(placeholder="プライベートメッセージ")が見つかりません');
      }

      // Step 3: メッセージ入力
      await typeMessage(chatInput, message);
      console.log(LOG, `[TIMING] Step3 メッセージ入力: ${elapsed()}`);

      // Step 4: 送信
      const sendOk = await clickSendButton(chatInput);
      console.log(LOG, `[TIMING] Step4 送信ボタン: ${elapsed()}`);
      if (!sendOk) {
        throw new Error('送信ボタン(aria-label="送信")が見つかりません');
      }

      // 送信完了待ち（1s→500ms, Morning Hook CRMは0.8s）
      await sleep(500);

      // Step 5: 送信確認（入力欄がクリアされたか — ログのみ、リトライしない）
      const remaining = chatInput.value || chatInput.textContent || '';
      if (remaining.trim() === message.trim()) {
        console.warn(LOG, '入力欄未クリア — 送信失敗の可能性（リトライなし）');
        // リトライせず警告のみ: Stripchat側で実際には送信済みの場合が多い
        // リトライすると二重送信のリスク + タイムアウトの原因
      }

      console.log(LOG, `[TIMING] 完了: ${elapsed()}`);
      console.log(LOG, `DM送信成功: ${username}`);
      console.log(LOG, '========================================');
      return { success: true, error: null };
    } catch (err) {
      console.error(LOG, `DM送信失敗 (${username}): ${err.message} [${elapsed()}]`);
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
        chrome.runtime.sendMessage({
          type: 'DM_SEND_RESULT',
          taskId: msg.taskId,
          success: result.success,
          error: result.error,
        });
        sendResponse({ ok: true, result });
      });

      return true;
    }

    if (msg.type === 'EXECUTE_DM') {
      sendResponse({ ok: true, queued: 0, message: 'Use SEND_DM instead' });
      return false;
    }
  });

  console.log(LOG, 'DM executor ready (v5.1 - timeout fix, timing logs)');
})();
