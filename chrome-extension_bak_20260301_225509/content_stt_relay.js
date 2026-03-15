/**
 * Strip Live Spot - Content STT Relay (ISOLATED world)
 * MAIN worldのcontent_stt.jsとbackground.jsの橋渡し。
 *
 * MAIN world → window.postMessage → このファイル → chrome.runtime.sendMessage → background.js
 * background.js → chrome.tabs.sendMessage → このファイル → window.postMessage → MAIN world
 */
(function () {
  'use strict';

  const LOG = '[LS-STT-RELAY]';
  const MSG_SOURCE = 'livespot-stt';
  const MSG_TYPE_CHUNK = 'LIVESPOT_AUDIO_CHUNK';
  const MSG_TYPE_STATUS = 'LIVESPOT_STT_STATUS';
  const CONTROL_TYPE = 'LIVESPOT_STT_CONTROL';

  let chunksSent = 0;

  // ============================================================
  // MAIN world → background.js: 音声チャンク転送
  // ============================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== MSG_SOURCE) return;

    // 音声チャンク → background.jsに転送（tabIdはbackground側でsender.tab.idから取得）
    if (event.data.type === MSG_TYPE_CHUNK) {
      chrome.runtime.sendMessage({
        type: 'AUDIO_CHUNK',
        data: event.data.data,          // base64 encoded WebM
        size: event.data.size,
        castName: event.data.castName,
        chunkIndex: event.data.chunkIndex,
        isFinal: event.data.isFinal || false,
        timestamp: event.data.timestamp,
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, 'チャンク転送失敗:', chrome.runtime.lastError.message);
          return;
        }
        chunksSent++;
        if (chunksSent % 12 === 0) {
          // 1分に1回ログ（5秒×12=60秒）
          console.log(LOG, 'チャンク累計送信:', chunksSent, 'cast=', event.data.castName);
        }
      });
      return;
    }

    // ステータス → background.jsに転送
    if (event.data.type === MSG_TYPE_STATUS) {
      chrome.runtime.sendMessage({
        type: 'STT_STATUS',
        status: event.data.status,
        castName: event.data.castName,
        message: event.data.message,
      }, () => {
        if (chrome.runtime.lastError) {
          // silent — status messages are non-critical
        }
      });
    }
  });

  // ============================================================
  // background.js → MAIN world: STT制御メッセージ転送
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'STT_STATE') {
      console.log(LOG, 'STT_STATE受信: enabled=', msg.enabled);
      window.postMessage({
        type: CONTROL_TYPE,
        action: msg.enabled ? 'start' : 'stop',
      }, '*');
      sendResponse({ ok: true });
      return false;
    }
  });

  // ============================================================
  // 起動時: 保存されたSTT状態を確認してMAIN worldに通知
  // ============================================================
  chrome.storage.local.get(['stt_enabled'], (data) => {
    if (data.stt_enabled === true) {
      console.log(LOG, 'STT有効状態を検出 → MAIN worldに開始通知（2秒後）');
      setTimeout(() => {
        window.postMessage({ type: CONTROL_TYPE, action: 'start' }, '*');
      }, 2000);
    }
  });

  console.log(LOG, 'Content STT Relay (ISOLATED) loaded');
})();
