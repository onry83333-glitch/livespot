/**
 * Strip Live Spot - DM Executor v4
 * Background から SEND_DM メッセージを受け取りStripchat上でDM送信を実行
 *
 * 【確定セレクタ（Morning Hook CRM DevTools確認済み）】
 *   PMボタン:       button[aria-label="PMを送信"]
 *   入力欄:         textarea[placeholder*="プライベートメッセージ"]
 *   送信ボタン:     button[aria-label="送信"]
 *   カメラアイコン:  button[aria-label="ファイルをアップロード"]
 *
 * フロー:
 *   background.js がタブをプロフィールURLへ遷移
 *   → SEND_DM メッセージ受信
 *   → button[aria-label="PMを送信"] をクリック
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
  const PM_SELECTOR = 'button[aria-label="PMを送信"]';
  const INPUT_SELECTOR = 'textarea[placeholder*="プライベートメッセージ"]';
  const SEND_SELECTOR = 'button[aria-label="送信"]';

  // ============================================================
  // DOM Helpers
  // ============================================================
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================
  // Step 1: PMボタンをクリック
  // ============================================================
  async function clickPMButton() {
    console.log(LOG, 'Step 1: PMボタン検索...');

    // Strategy 1: 確定セレクタ（最優先）
    let btn = document.querySelector(PM_SELECTOR);
    if (btn) {
      console.log(LOG, 'PMボタン発見 (確定セレクタ): button[aria-label="PMを送信"]');
      btn.click();
      return true;
    }

    // Strategy 2: XPathで「PMを送信」テキストを含むbutton
    try {
      const xpath = "//button[contains(., 'PMを送信')]";
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      btn = result.singleNodeValue;
      if (btn) {
        console.log(LOG, 'PMボタン発見 (XPath): PMを送信');
        btn.click();
        return true;
      }
    } catch (e) { /* ignore */ }

    // Strategy 3: aria-label/テキストに "PM" を含むボタン（ヘッダー除外）
    const allBtns = document.querySelectorAll('button');
    for (const b of allBtns) {
      // ヘッダー/ナビ内は除外
      if (isInHeaderOrNav(b)) continue;

      const aria = b.getAttribute('aria-label') || '';
      const text = (b.textContent || '').trim();

      if (/PM/.test(aria) || /PM/.test(text)) {
        console.log(LOG, `PMボタン発見 (フォールバック): aria="${aria}" text="${text}"`);
        b.click();
        return true;
      }
    }

    // Strategy 4: 英語版 "Send PM" / "Send Message"
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
      console.log(LOG, `  aria="${aria}" text="${text}" class="${cls}"`);
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
  async function findDMInput(maxWait = 8000) {
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

      await sleep(500);
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
  // DM送信メインフロー
  // ============================================================
  async function executeDM(username, message) {
    console.log(LOG, '========================================');
    console.log(LOG, `DM送信開始: ${username}`);
    console.log(LOG, `URL: ${window.location.href}`);

    try {
      // Step 1: PMボタンクリック
      const pmOk = await clickPMButton();
      if (!pmOk) {
        throw new Error('PMボタン(aria-label="PMを送信")が見つかりません');
      }

      // PMクリック後、ダイアログが開くのを待つ
      await sleep(2000);

      // Step 2: DM入力欄を探す
      const chatInput = await findDMInput(8000);
      if (!chatInput) {
        throw new Error('DM入力欄(placeholder="プライベートメッセージ")が見つかりません');
      }

      // Step 3: メッセージ入力
      await typeMessage(chatInput, message);
      await sleep(500);

      // Step 4: 送信
      const sendOk = await clickSendButton(chatInput);
      if (!sendOk) {
        throw new Error('送信ボタン(aria-label="送信")が見つかりません');
      }

      // 送信完了待ち
      await sleep(2000);

      // Step 5: 送信確認（入力欄がクリアされたか）
      const remaining = chatInput.value || chatInput.textContent || '';
      if (remaining.trim() === message.trim()) {
        // 再試行: もう一度送信ボタンを押す
        console.log(LOG, '入力欄未クリア → 送信リトライ...');
        await clickSendButton(chatInput);
        await sleep(2000);
        const remaining2 = chatInput.value || chatInput.textContent || '';
        if (remaining2.trim() === message.trim()) {
          throw new Error('メッセージが送信されなかった可能性があります');
        }
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

  console.log(LOG, 'DM executor ready (v4 - confirmed selectors)');
})();
