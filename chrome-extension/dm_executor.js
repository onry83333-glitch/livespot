/**
 * Strip Live Spot - DM Executor
 * Background から受け取ったDMタスクをStripchat上で実行
 */

(function () {
  'use strict';

  const LOG = '[LS-DM]';
  let isExecuting = false;
  let taskQueue = [];

  // ============================================================
  // DM 実行
  // ============================================================
  async function executeDM(task) {
    const { id, user_name, profile_url, message } = task;
    console.log(LOG, `Executing DM to ${user_name} (id: ${id})`);

    try {
      // Step 1: DM入力欄を探す
      let dmInput = await findDMInput();

      if (!dmInput) {
        // メッセージボタンをクリックしてダイアログを開く
        const msgButton = document.querySelector(
          'button[class*="message"], a[class*="message"], ' +
          '[data-testid="send-message-btn"], ' +
          'button[title*="Message"], button[title*="メッセージ"]'
        );

        if (msgButton) {
          msgButton.click();
          await sleep(1500);
          dmInput = await findDMInput();
        }

        if (!dmInput) {
          throw new Error('DM input not found on page');
        }
      }

      // Step 2: メッセージ入力
      await simulateTyping(dmInput, message);
      await sleep(300);

      // Step 3: 送信ボタンを探してクリック
      const sendBtn = findSendButton(dmInput);
      if (!sendBtn) throw new Error('Send button not found');

      sendBtn.click();
      await sleep(1500);

      // Step 4: 送信確認（入力欄がクリアされたか）
      const remaining = dmInput.value || dmInput.textContent || '';
      if (remaining === message) {
        throw new Error('Message may not have been sent');
      }

      console.log(LOG, `DM sent to ${user_name}`);
      return { status: 'success', error: null };
    } catch (err) {
      console.error(LOG, `DM failed for ${user_name}:`, err.message);
      return { status: 'error', error: err.message };
    }
  }

  // ============================================================
  // DOM Helpers
  // ============================================================
  async function findDMInput() {
    const selectors = [
      '[data-testid="dm-input"]',
      'textarea[class*="message"]',
      'input[class*="message"]',
      '[class*="dmInput"]',
      '[class*="DmInput"]',
      'textarea[placeholder*="message"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="メッセージ"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // モーダル/ダイアログ内を検索
    const modal = document.querySelector(
      '[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]'
    );
    if (modal) {
      const textarea = modal.querySelector('textarea');
      if (textarea) return textarea;
      const input = modal.querySelector('input[type="text"]');
      if (input) return input;
    }

    return null;
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          obs.disconnect();
          resolve(found);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  async function simulateTyping(element, text) {
    element.focus();
    element.click();

    // React controlled input 対応: native setter で値をセット
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

    await sleep(200);
  }

  function findSendButton(nearElement) {
    const container =
      nearElement.closest(
        'form, [class*="message"], [class*="dialog"], [class*="modal"]'
      ) || nearElement.parentElement?.parentElement || nearElement.parentElement;

    if (!container) return null;

    // セレクタ順に試行
    const selectors = [
      'button[type="submit"]',
      'button[class*="send"], button[class*="Send"]',
      '[data-testid="send-button"]',
      'button[title*="Send"], button[title*="送信"]',
    ];

    for (const sel of selectors) {
      const btn = container.querySelector(sel);
      if (btn) return btn;
    }

    // Fallback: テキストから判定
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      const title = (btn.title || '').toLowerCase();
      if (
        text.includes('send') || text.includes('送信') ||
        title.includes('send') || title.includes('送信')
      ) {
        return btn;
      }
    }

    // SVGアイコンボタン（送信矢印など）
    const svgBtns = container.querySelectorAll('button svg');
    if (svgBtns.length === 1) {
      return svgBtns[0].closest('button');
    }

    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================
  // Task Queue
  // ============================================================
  async function processQueue() {
    if (isExecuting || taskQueue.length === 0) return;
    isExecuting = true;

    while (taskQueue.length > 0) {
      const task = taskQueue.shift();
      const result = await executeDM(task);

      // 結果をbackgroundに報告
      chrome.runtime.sendMessage({
        type: 'DM_RESULT',
        dm_id: task.id,
        status: result.status,
        error: result.error,
      });

      // DM間のランダム遅延（検出回避）
      if (taskQueue.length > 0) {
        const delay = 3000 + Math.random() * 2000;
        await sleep(delay);
      }
    }

    isExecuting = false;
  }

  // ============================================================
  // Message Handler
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXECUTE_DM') {
      console.log(LOG, `Received ${msg.tasks.length} DM tasks`);
      taskQueue.push(...msg.tasks);
      processQueue();
      sendResponse({ ok: true, queued: msg.tasks.length });
      return false;
    }
  });

  console.log(LOG, 'DM executor ready');
})();
