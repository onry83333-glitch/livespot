/**
 * Strip Live Spot - Content Whisper Overlay
 * background.jsからのWhisper通知をStripchatページにオーバーレイ表示
 */
(function () {
  'use strict';

  const LOG = '[LS-WHISPER]';
  let activeOverlay = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SHOW_WHISPER') {
      console.log(LOG, 'Whisper受信:', msg.message?.substring(0, 30));
      showWhisperOverlay(msg);
      sendResponse({ ok: true });
    }
  });

  function showWhisperOverlay(data) {
    if (activeOverlay) {
      activeOverlay.remove();
      activeOverlay = null;
    }

    // CSS animation injection (once)
    if (!document.getElementById('livespot-whisper-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'livespot-whisper-styles';
      styleEl.textContent = `
        @keyframes livespot-whisper-in {
          from { transform: translateX(400px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes livespot-whisper-out {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(400px); opacity: 0; }
        }
        @keyframes livespot-whisper-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(56,189,248,0.4); }
          50% { box-shadow: 0 0 0 10px rgba(56,189,248,0); }
        }
      `;
      document.head.appendChild(styleEl);
    }

    const overlay = document.createElement('div');
    overlay.id = 'livespot-whisper-overlay';
    overlay.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 999999;
      max-width: 360px; min-width: 280px;
      background: linear-gradient(135deg, rgba(15,23,42,0.98), rgba(30,41,59,0.98));
      backdrop-filter: blur(20px);
      border: 1px solid rgba(56,189,248,0.25);
      border-radius: 16px; padding: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(56,189,248,0.1);
      animation: livespot-whisper-in 0.3s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #f1f5f9; cursor: pointer;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
      font-size: 11px; font-weight: 600; color: #38bdf8;
      text-transform: uppercase; letter-spacing: 0.05em;
    `;
    header.textContent = '\uD83D\uDCAC Strip Live Spot - \u3055\u3055\u3084\u304D';
    overlay.appendChild(header);

    // Template tag
    if (data.template_name) {
      const tag = document.createElement('div');
      tag.style.cssText = `
        display: inline-block; padding: 3px 8px;
        background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.3);
        border-radius: 6px; font-size: 9px; font-weight: 500; color: #a78bfa;
        margin-bottom: 10px;
      `;
      tag.textContent = data.template_name;
      overlay.appendChild(tag);
    }

    // Message body
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      font-size: 16px; line-height: 1.6; color: #f1f5f9;
      margin-bottom: 12px; white-space: pre-wrap; word-break: break-word;
    `;
    msgDiv.textContent = data.message;
    overlay.appendChild(msgDiv);

    // Dismiss instruction
    const hint = document.createElement('div');
    hint.style.cssText = `
      font-size: 10px; color: #64748b; text-align: center;
      padding-top: 8px; border-top: 1px solid rgba(100,116,139,0.2);
    `;
    hint.textContent = '\u30AF\u30EA\u30C3\u30AF\u3067\u9589\u3058\u308B';
    overlay.appendChild(hint);

    // Dismiss handler
    const dismiss = () => {
      overlay.style.animation = 'livespot-whisper-out 0.2s ease-in forwards';
      setTimeout(() => {
        overlay.remove();
        activeOverlay = null;
      }, 200);
      chrome.runtime.sendMessage({ type: 'WHISPER_READ', whisper_id: data.whisper_id });
    };

    overlay.addEventListener('click', dismiss);

    // Auto-dismiss after 15s
    setTimeout(() => {
      if (overlay.parentNode) dismiss();
    }, 15000);

    document.body.appendChild(overlay);
    activeOverlay = overlay;
  }

  console.log(LOG, 'Content Whisperスクリプト読込完了');
})();
