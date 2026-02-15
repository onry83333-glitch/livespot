/**
 * Strip Live Spot - DM Executor
 * Background から SEND_DM メッセージを受け取りStripchat上でDM送信を実行
 *
 * フロー:
 *   background.js がタブをプロフィールURLへ遷移させる
 *   → ページロード完了後に本スクリプトが注入される
 *   → SEND_DM メッセージを受信
 *   → DMダイアログを開く → メッセージ入力 → 送信 → 結果報告
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

  function waitForElement(selectors, timeout = 8000) {
    return new Promise((resolve) => {
      // 既存要素を確認
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { resolve(el); return; }
      }

      const obs = new MutationObserver(() => {
        for (const sel of selectors) {
          const found = document.querySelector(sel);
          if (found) {
            obs.disconnect();
            resolve(found);
            return;
          }
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
  // DMダイアログを開く
  // ============================================================
  async function openDMDialog() {
    // プロフィールページ上の「メッセージ送信」ボタンを探す
    const btnSelectors = [
      // Stripchat のプロフィールページDMボタン候補
      'button[data-test-id="send-message"]',
      'a[data-test-id="send-message"]',
      '[class*="SendMessage"]',
      '[class*="sendMessage"]',
      '[class*="send-message"]',
      'button[class*="message-button"]',
      'a[href*="/messages/"]',
    ];

    let dmBtn = null;
    for (const sel of btnSelectors) {
      dmBtn = document.querySelector(sel);
      if (dmBtn) break;
    }

    // フォールバック: テキスト/aria-labelで探す
    if (!dmBtn) {
      const allBtns = document.querySelectorAll('button, a[role="button"]');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const title = (btn.title || '').toLowerCase();
        if (
          text.includes('send message') || text.includes('message') ||
          text.includes('メッセージ') || text.includes('メッセージを送る') ||
          aria.includes('message') || aria.includes('メッセージ') ||
          title.includes('message') || title.includes('メッセージ')
        ) {
          // メッセージ入力欄自体のボタン(送信ボタン)は除外
          if (!btn.closest('form') && !btn.closest('[class*="chat-input"]')) {
            dmBtn = btn;
            break;
          }
        }
      }
    }

    // SVGアイコンのみのボタン（封筒アイコンなど）
    if (!dmBtn) {
      const svgBtns = document.querySelectorAll('button svg, a[role="button"] svg');
      for (const svg of svgBtns) {
        const btn = svg.closest('button') || svg.closest('a[role="button"]');
        if (!btn) continue;
        const cls = (btn.className || '') + ' ' + (btn.parentElement?.className || '');
        if (/message|dm|mail|envelope/i.test(cls)) {
          dmBtn = btn;
          break;
        }
      }
    }

    if (!dmBtn) {
      console.warn(LOG, 'DMボタンが見つかりません');
      return false;
    }

    console.log(LOG, 'DMボタンクリック:', dmBtn.tagName, dmBtn.className?.substring(0, 50));
    dmBtn.click();
    await sleep(2000);
    return true;
  }

  // ============================================================
  // DM入力欄を探す
  // ============================================================
  async function findDMInput() {
    const inputSelectors = [
      '[data-testid="dm-input"]',
      '[data-test-id="dm-input"]',
      'textarea[class*="message"]',
      'textarea[class*="Message"]',
      'input[class*="message"]',
      '[class*="dmInput"]',
      '[class*="DmInput"]',
      '[class*="dm-input"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="メッセージ"]',
      'textarea[placeholder*="Write"]',
      'textarea[placeholder*="write"]',
    ];

    // まず直接探す
    for (const sel of inputSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // モーダル/ダイアログ内を検索
    const modalSelectors = [
      '[class*="modal"]', '[class*="Modal"]',
      '[class*="dialog"]', '[class*="Dialog"]',
      '[class*="popup"]', '[class*="Popup"]',
      '[class*="overlay"]', '[class*="Overlay"]',
      '[role="dialog"]',
    ];

    for (const mSel of modalSelectors) {
      const modal = document.querySelector(mSel);
      if (!modal) continue;
      const textarea = modal.querySelector('textarea');
      if (textarea) return textarea;
      const input = modal.querySelector('input[type="text"]');
      if (input) return input;
    }

    // waitForElement で最大5秒待機
    return await waitForElement(inputSelectors, 5000);
  }

  // ============================================================
  // メッセージ入力（React controlled input対応）
  // ============================================================
  async function simulateTyping(element, text) {
    element.focus();
    element.click();
    await sleep(100);

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

    // contentEditable 対応
    if (element.contentEditable === 'true') {
      element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }

    await sleep(300);
  }

  // ============================================================
  // 送信ボタンを探してクリック
  // ============================================================
  function findSendButton(nearElement) {
    const container =
      nearElement.closest('form, [class*="message"], [class*="dialog"], [class*="modal"], [role="dialog"]')
      || nearElement.parentElement?.parentElement
      || nearElement.parentElement;

    if (!container) return null;

    const selectors = [
      'button[type="submit"]',
      'button[class*="send"], button[class*="Send"]',
      '[data-testid="send-button"]',
      '[data-test-id="send-button"]',
      'button[title*="Send"], button[title*="送信"]',
    ];

    for (const sel of selectors) {
      const btn = container.querySelector(sel);
      if (btn) return btn;
    }

    // テキストから判定
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase().trim();
      const title = (btn.title || '').toLowerCase();
      if (
        text.includes('send') || text.includes('送信') ||
        title.includes('send') || title.includes('送信')
      ) {
        return btn;
      }
    }

    // SVGアイコンのみの送信ボタン（矢印など）
    const svgBtns = container.querySelectorAll('button');
    for (const btn of svgBtns) {
      if (btn.querySelector('svg') && !btn.textContent?.trim()) {
        return btn;
      }
    }

    return null;
  }

  // ============================================================
  // DM送信メインフロー
  // ============================================================
  async function executeDM(username, message) {
    console.log(LOG, `DM送信開始: ${username}`);

    try {
      // Step 1: DMダイアログを開く
      const dialogOpened = await openDMDialog();
      if (!dialogOpened) {
        throw new Error('DMダイアログを開けませんでした');
      }

      // Step 2: DM入力欄を探す
      const dmInput = await findDMInput();
      if (!dmInput) {
        throw new Error('DM入力欄が見つかりません');
      }

      console.log(LOG, 'DM入力欄発見:', dmInput.tagName, dmInput.className?.substring(0, 50));

      // Step 3: メッセージを入力
      await simulateTyping(dmInput, message);
      await sleep(500);

      // Step 4: 送信ボタンを探してクリック
      const sendBtn = findSendButton(dmInput);
      if (!sendBtn) {
        // Enter キーでの送信を試行
        console.log(LOG, '送信ボタン未検出 → Enterキー送信を試行');
        dmInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        await sleep(500);
        dmInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      } else {
        console.log(LOG, '送信ボタンクリック:', sendBtn.tagName);
        sendBtn.click();
      }

      await sleep(2000);

      // Step 5: 送信確認（入力欄がクリアされたか）
      const remaining = dmInput.value || dmInput.textContent || '';
      if (remaining.trim() === message.trim()) {
        throw new Error('メッセージが送信されなかった可能性があります');
      }

      console.log(LOG, `DM送信成功: ${username}`);
      return { success: true, error: null };
    } catch (err) {
      console.error(LOG, `DM送信失敗 (${username}):`, err.message);
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

  console.log(LOG, 'DM executor ready (v2)');
})();
