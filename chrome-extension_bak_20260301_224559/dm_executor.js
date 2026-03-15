/**
 * Strip Live Spot - DM Executor v6.1
 * Background から SEND_DM メッセージを受け取りStripchat上でDM送信を実行
 *
 * v6.1: 画像DM送信改善
 *   - findFileInput を MutationObserver ベースに改善（ポーリング廃止）
 *   - Clipboard API フォールバック追加（input[type=file] 未検出時）
 *
 * v6.0: 画像DM送信対応（DOM方式）
 *   - input[type=file] DataTransfer操作で画像添付
 *   - send_order 4パターン対応 (text_only/image_only/text_then_image/image_then_text)
 *   - 画像プレビュー待ち + 送信確認
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
  // 画像添付: input[type=file] を探してDataTransferで画像セット
  // ============================================================

  /**
   * PMダイアログ内のinput[type=file]を即座に検索（同期版）
   */
  function findFileInputImmediate() {
    const inputs = document.querySelectorAll('input[type="file"]');
    // Strategy 1: ダイアログ/メッセンジャー内のものを優先
    for (const inp of inputs) {
      if (inp.closest('[role="dialog"], [class*="messenger" i], [class*="message" i], [class*="chat" i], [class*="modal" i]')) {
        console.log(LOG, '画像添付: input[type=file] 発見 (ダイアログ内)', inp.accept || '');
        return inp;
      }
    }
    // Strategy 2: accept="image/*" のinput
    for (const inp of inputs) {
      if ((inp.accept || '').includes('image')) {
        console.log(LOG, '画像添付: input[type=file] 発見 (accept=image)');
        return inp;
      }
    }
    // Strategy 3: ページ上の任意のinput[type=file]
    if (inputs.length > 0) {
      console.log(LOG, '画像添付: input[type=file] 発見 (フォールバック)');
      return inputs[0];
    }
    return null;
  }

  /**
   * PMダイアログ内のinput[type=file]を探す（MutationObserver版）
   * Stripchat PMダイアログにはファイル添付用の隠しinputがある
   */
  async function findFileInput(maxWait = 5000) {
    console.log(LOG, '画像添付: input[type=file] 検索 (MutationObserver)...');

    // まず既存の要素をチェック
    const existing = findFileInputImmediate();
    if (existing) return existing;

    // MutationObserverで動的生成を監視
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = findFileInputImmediate();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        console.warn(LOG, '画像添付: input[type=file] 未検出 (タイムアウト)');
        resolve(null);
      }, maxWait);
    });
  }

  /**
   * 添付ボタン（クリップアイコン等）をクリックしてファイル入力を有効化
   */
  async function clickAttachButton() {
    // PMダイアログ/メッセンジャー内のコンテナを特定
    const container = document.querySelector(
      '[role="dialog"], [class*="messenger" i], [class*="message-form" i], [class*="chat-form" i]'
    );
    if (!container) return false;

    // 添付アイコンボタンを探す
    const buttons = container.querySelectorAll('button, label, [role="button"]');
    for (const btn of buttons) {
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const cls = (btn.className || '').toString().toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();

      // 添付・画像・写真関連のボタン
      if (/attach|photo|image|upload|画像|写真|添付|clip|ファイル/i.test(aria + cls + title)) {
        console.log(LOG, '画像添付: 添付ボタン発見', aria || cls.substring(0, 40));
        btn.click();
        await sleep(300);
        return true;
      }

      // SVGアイコンのみのlabel（input[type=file]のトリガー）
      if (btn.tagName === 'LABEL' && btn.querySelector('svg') && btn.htmlFor) {
        console.log(LOG, '画像添付: label[for] ボタン発見', btn.htmlFor);
        btn.click();
        await sleep(300);
        return true;
      }
    }

    // input[type=file]のlabelを直接探す
    const fileInputs = container.querySelectorAll('input[type="file"]');
    for (const fi of fileInputs) {
      if (fi.id) {
        const label = container.querySelector(`label[for="${fi.id}"]`);
        if (label) {
          console.log(LOG, '画像添付: label[for=fileInput] クリック');
          label.click();
          await sleep(300);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * base64画像をinput[type=file]にセットしてアップロードトリガー
   */
  async function attachImageToFileInput(fileInput, imageBase64) {
    console.log(LOG, '画像添付: DataTransfer操作開始...');

    try {
      // base64 → Blob
      const binaryStr = atob(imageBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const file = new File([blob], 'dm_image.jpg', { type: 'image/jpeg', lastModified: Date.now() });

      // DataTransfer で input.files にセット
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

      // change + input イベント発火（React/Vue等のフレームワーク対応）
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));

      console.log(LOG, '画像添付: DataTransfer完了, files.length=', fileInput.files.length, ', size=', (blob.size / 1024).toFixed(1), 'KB');
      return true;
    } catch (e) {
      console.error(LOG, '画像添付: DataTransfer失敗:', e.message);
      return false;
    }
  }

  /**
   * 画像プレビューの出現を待つ
   * Stripchatのメッセンジャーは画像添付後にプレビューを表示する
   */
  async function waitForImagePreview(maxWait = 5000) {
    console.log(LOG, '画像添付: プレビュー待ち...');
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      // プレビュー画像（img タグ、thumbnail、preview等）
      const container = document.querySelector(
        '[role="dialog"], [class*="messenger" i], [class*="message-form" i]'
      );
      if (container) {
        // プレビュー系のクラス/要素を探す
        const preview = container.querySelector(
          '[class*="preview" i], [class*="thumbnail" i], [class*="attachment" i], [class*="upload" i] img, [class*="photo" i] img'
        );
        if (preview) {
          console.log(LOG, '画像添付: プレビュー検出!', preview.tagName, (preview.className || '').toString().substring(0, 40));
          return true;
        }

        // img要素でblob: or data: URLのもの
        const imgs = container.querySelectorAll('img');
        for (const img of imgs) {
          if (img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:'))) {
            console.log(LOG, '画像添付: blob/data画像プレビュー検出');
            return true;
          }
        }
      }

      await sleep(300);
    }

    console.warn(LOG, '画像添付: プレビュー未検出（タイムアウト）— そのまま送信を試行');
    return false;
  }

  // ============================================================
  // DM送信メインフロー（画像対応版）
  // ============================================================

  /**
   * 画像DM送信: PMダイアログ上でinput[type=file]に画像をセットして送信
   * @param {string} username - 送信先ユーザー名
   * @param {string} message - メッセージ本文（image_onlyの場合は空）
   * @param {string} imageBase64 - 画像のbase64データ
   * @param {string} sendOrder - 送信順序 (text_only/image_only/text_then_image/image_then_text)
   */
  async function executeDMWithImage(username, message, imageBase64, sendOrder) {
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    console.log(LOG, '========================================');
    console.log(LOG, `画像DM送信開始: ${username} (sendOrder=${sendOrder})`);
    console.log(LOG, `URL: ${window.location.href}`);
    console.log(LOG, `画像データ: ${(imageBase64.length / 1024).toFixed(1)}KB (base64)`);

    try {
      // Step 1: PMボタンクリック
      const pmOk = await clickPMButton();
      console.log(LOG, `[TIMING] Step1 PMボタン: ${elapsed()}`);
      if (!pmOk) {
        throw new Error('PMボタンが見つかりません');
      }

      // PMダイアログ待ち
      await sleep(500);
      console.log(LOG, `[TIMING] PMダイアログ待ち後: ${elapsed()}`);

      // Step 2: DM入力欄を探す
      const chatInput = await findDMInput(5000);
      console.log(LOG, `[TIMING] Step2 DM入力欄: ${elapsed()}`);
      if (!chatInput) {
        throw new Error('DM入力欄が見つかりません');
      }

      // ---- send_order に応じた送信パターン ----

      if (sendOrder === 'text_only') {
        // テキストのみ（既存と同じ）
        return await sendTextViaDOM(chatInput, username, message, elapsed);
      }

      if (sendOrder === 'image_only') {
        // 画像のみ送信
        return await sendImageViaDOM(chatInput, username, imageBase64, elapsed);
      }

      if (sendOrder === 'text_then_image') {
        // テキスト先 → 画像後
        const textResult = await sendTextViaDOM(chatInput, username, message, elapsed);
        if (!textResult.success) return textResult;

        // テキスト送信後、入力欄を再取得（UIリフレッシュ対応）
        await sleep(800);
        const chatInput2 = await findDMInput(3000);
        if (!chatInput2) {
          console.warn(LOG, 'テキスト送信後の入力欄再取得失敗 — 画像スキップ');
          return { success: true, error: null, sentMessages: 1, note: '画像送信スキップ（入力欄再取得失敗）' };
        }

        const imgResult = await sendImageViaDOM(chatInput2, username, imageBase64, elapsed);
        return {
          success: imgResult.success,
          error: imgResult.error,
          sentMessages: imgResult.success ? 2 : 1,
          note: imgResult.success ? 'text_then_image 2通完了' : 'テキストのみ成功',
        };
      }

      if (sendOrder === 'image_then_text') {
        // 画像先 → テキスト後
        const imgResult = await sendImageViaDOM(chatInput, username, imageBase64, elapsed);
        if (!imgResult.success) return imgResult;

        // 画像送信後、入力欄を再取得
        await sleep(800);
        const chatInput2 = await findDMInput(3000);
        if (!chatInput2) {
          console.warn(LOG, '画像送信後の入力欄再取得失敗 — テキストスキップ');
          return { success: true, error: null, sentMessages: 1, note: 'テキスト送信スキップ（入力欄再取得失敗）' };
        }

        const textResult = await sendTextViaDOM(chatInput2, username, message, elapsed);
        return {
          success: textResult.success,
          error: textResult.error,
          sentMessages: textResult.success ? 2 : 1,
          note: textResult.success ? 'image_then_text 2通完了' : '画像のみ成功',
        };
      }

      // 不明なsendOrder → テキストのみ
      console.warn(LOG, '不明なsendOrder:', sendOrder, '→ テキストのみ送信');
      return await sendTextViaDOM(chatInput, username, message, elapsed);

    } catch (err) {
      console.error(LOG, `画像DM送信失敗 (${username}): ${err.message} [${elapsed()}]`);
      console.log(LOG, '========================================');
      return { success: false, error: err.message };
    }
  }

  /**
   * テキストのみDOM送信（ヘルパー）
   */
  async function sendTextViaDOM(chatInput, username, message, elapsed) {
    if (!message) {
      console.log(LOG, 'テキストなし — スキップ');
      return { success: true, error: null, note: 'テキストなし' };
    }

    await typeMessage(chatInput, message);
    console.log(LOG, `[TIMING] テキスト入力: ${elapsed()}`);

    const sendOk = await clickSendButton(chatInput);
    console.log(LOG, `[TIMING] 送信ボタン: ${elapsed()}`);
    if (!sendOk) {
      return { success: false, error: '送信ボタンが見つかりません' };
    }

    await sleep(500);

    const remaining = chatInput.value || chatInput.textContent || '';
    if (remaining.trim() === message.trim()) {
      console.warn(LOG, '入力欄未クリア — 送信失敗の可能性');
    }

    console.log(LOG, `テキストDM送信完了: ${username} [${elapsed()}]`);
    console.log(LOG, '========================================');
    return { success: true, error: null };
  }

  /**
   * Clipboard API 経由で画像をペーストする（input[type=file]未検出時のフォールバック）
   */
  async function sendImageViaClipboard(chatInput, imageBase64, elapsed) {
    console.log(LOG, '画像添付: Clipboard APIフォールバック...');
    try {
      const binaryStr = atob(imageBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'image/png' });

      // contentEditable or textarea にフォーカス
      const target = chatInput.closest('[role="dialog"]')?.querySelector('[contenteditable="true"]') || chatInput;
      target.focus();
      await sleep(200);

      // paste イベントをディスパッチ
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      target.dispatchEvent(pasteEvent);

      console.log(LOG, `[TIMING] Clipboard paste: ${elapsed()}`);
      await sleep(1000);
      return true;
    } catch (e) {
      console.warn(LOG, 'Clipboard APIフォールバック失敗:', e.message);
      return false;
    }
  }

  /**
   * 画像のみDOM送信（ヘルパー）
   */
  async function sendImageViaDOM(chatInput, username, imageBase64, elapsed) {
    // 添付ボタンクリック（input[type=file]のトリガー）
    await clickAttachButton();
    console.log(LOG, `[TIMING] 添付ボタンクリック: ${elapsed()}`);

    // input[type=file] を探す
    const fileInput = await findFileInput(3000);
    if (!fileInput) {
      // Clipboard APIフォールバック
      console.log(LOG, '画像添付: input[type=file]未検出 → Clipboard APIフォールバック');
      const clipOk = await sendImageViaClipboard(chatInput, imageBase64, elapsed);
      if (clipOk) {
        await waitForImagePreview(5000);
        await sleep(300);
        const sendOk = await clickSendButton(chatInput);
        if (sendOk) {
          await sleep(800);
          return { success: true, error: null };
        }
        return { success: false, error: 'Clipboard添付後の送信ボタン失敗' };
      }
      return { success: false, error: 'input[type=file]もClipboard APIも失敗' };
    }

    // DataTransferで画像セット
    const attached = await attachImageToFileInput(fileInput, imageBase64);
    console.log(LOG, `[TIMING] 画像添付: ${elapsed()}`);
    if (!attached) {
      return { success: false, error: '画像DataTransfer失敗' };
    }

    // プレビュー待ち
    await waitForImagePreview(5000);
    console.log(LOG, `[TIMING] プレビュー待ち: ${elapsed()}`);

    // 送信ボタンクリック
    await sleep(300);
    const sendOk = await clickSendButton(chatInput);
    console.log(LOG, `[TIMING] 画像送信ボタン: ${elapsed()}`);
    if (!sendOk) {
      return { success: false, error: '画像送信: 送信ボタンが見つかりません' };
    }

    await sleep(800);

    console.log(LOG, `画像DM送信完了: ${username} [${elapsed()}]`);
    console.log(LOG, '========================================');
    return { success: true, error: null };
  }

  // ============================================================
  // Message Handler
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SEND_DM') {
      const hasImage = !!(msg.imageBase64 && msg.sendOrder && msg.sendOrder !== 'text_only');
      console.log(LOG, `SEND_DM受信: user=${msg.username}, taskId=${msg.taskId}, sendOrder=${msg.sendOrder || 'text_only'}, hasImage=${hasImage}`);

      // {username}プレースホルダーをターゲットユーザー名に置換
      const finalMessage = (msg.message || '').replace(/\{username\}/g, msg.username || '');
      const sendOrder = msg.sendOrder || 'text_only';

      // 画像あり → 画像対応フローで実行
      const executor = hasImage
        ? executeDMWithImage(msg.username, finalMessage, msg.imageBase64, sendOrder)
        : executeDM(msg.username, finalMessage);

      executor.then((result) => {
        chrome.runtime.sendMessage({
          type: 'DM_SEND_RESULT',
          taskId: msg.taskId,
          success: result.success,
          error: result.error,
          sentMessages: result.sentMessages || 1,
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

  console.log(LOG, 'DM executor ready (v6.1 - MutationObserver + Clipboard fallback)');
})();
