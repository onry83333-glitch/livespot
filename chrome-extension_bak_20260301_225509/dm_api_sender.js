/**
 * Strip Live Spot - DM API Sender v3.0 (stub)
 * DM送信はbackground.js chrome.scripting.executeScript (world:'MAIN') に移行済み。
 * このContent Scriptは互換性のためPING応答のみ残す。
 */
(function () {
  'use strict';
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'DM_API_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'DM_API_CLEAR_CACHE') {
      sendResponse({ ok: true });
      return false;
    }
  });
  console.log('[LS-DM-API] stub ready (v3.0 — send logic moved to background.js)');
})();
