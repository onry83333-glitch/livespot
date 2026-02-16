/**
 * Strip Live Spot - Content STT (MAIN world)
 * Stripchat配信の<video>要素から音声をキャプチャし、
 * 5秒チャンク（WebM/Opus, 64kbps）をbase64化してpostMessageで送信。
 *
 * MAIN worldで実行される理由:
 *   video.captureStream() はページコンテキストでのみ動作する。
 *   ISOLATED worldではMediaStreamを取得できない。
 *
 * 通信パターン:
 *   content_stt.js (MAIN) → window.postMessage → content_stt_relay.js (ISOLATED)
 *   → chrome.runtime.sendMessage → background.js → FastAPI /api/stt/transcribe
 *
 * Morning Hook CRM audio_capture.js と同アーキテクチャ。
 */
(function () {
  'use strict';

  var LOG = '[LS-STT]';
  var CHUNK_INTERVAL_MS = 5000;        // 5秒チャンク（Morning Hook実証済み）
  var MIME_TYPE = 'audio/webm;codecs=opus';
  var MIME_FALLBACK = 'audio/webm';
  var BITRATE = 64000;                 // 64kbps（音声には十分）
  var MSG_SOURCE = 'livespot-stt';
  var MSG_TYPE_CHUNK = 'LIVESPOT_AUDIO_CHUNK';
  var MSG_TYPE_STATUS = 'LIVESPOT_STT_STATUS';
  var CONTROL_TYPE = 'LIVESPOT_STT_CONTROL';
  var FIND_VIDEO_INTERVAL = 3000;      // ビデオ要素検索リトライ間隔
  var FIND_VIDEO_MAX_RETRY = 20;       // 最大60秒

  var mediaRecorder = null;
  var audioStream = null;
  var recording = false;
  var castName = '';
  var chunkIndex = 0;

  // ============================================================
  // キャスト名抽出（content_spy.jsと同ロジック）
  // ============================================================
  function extractCastName() {
    var match = location.pathname.match(/^\/([^/\?#]+)/);
    if (match && match[1]) {
      var reserved = [
        'user', 'favorites', 'settings', 'messages',
        'login', 'signup', 'search', 'categories',
      ];
      if (reserved.indexOf(match[1].toLowerCase()) === -1) {
        return match[1];
      }
    }
    var titleMatch = document.title.match(/^(.+?)\s*[-|–]/);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
    return '';
  }

  // ============================================================
  // ビデオ要素検出（Morning Hook findVideoElement準拠）
  // ============================================================
  function findVideoElement() {
    var videos = document.querySelectorAll('video');
    if (videos.length === 0) return null;

    // Priority 1: 再生中 + blob src（Stripchatメインプレイヤー）
    for (var i = 0; i < videos.length; i++) {
      if (!videos[i].paused && videos[i].src && videos[i].src.indexOf('blob:') === 0) {
        return videos[i];
      }
    }
    // Priority 2: 再生中
    for (var i = 0; i < videos.length; i++) {
      if (!videos[i].paused) {
        return videos[i];
      }
    }
    // Priority 3: readyState >= 2（HAVE_CURRENT_DATA）
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].readyState >= 2) {
        return videos[i];
      }
    }
    return null;
  }

  // ============================================================
  // ステータス送信
  // ============================================================
  function sendStatus(status, message) {
    window.postMessage({
      source: MSG_SOURCE,
      type: MSG_TYPE_STATUS,
      status: status,
      castName: castName,
      message: message || '',
    }, '*');
  }

  // ============================================================
  // チャンク送信（base64）
  // ============================================================
  function sendChunk(buffer, index, isFinal) {
    // ArrayBuffer → base64
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    var base64 = btoa(binary);

    window.postMessage({
      source: MSG_SOURCE,
      type: MSG_TYPE_CHUNK,
      data: base64,
      size: buffer.byteLength,
      castName: castName,
      chunkIndex: index,
      isFinal: isFinal,
      timestamp: new Date().toISOString(),
    }, '*');

    console.log(LOG, 'Chunk #' + index + ' sent: ' + Math.round(buffer.byteLength / 1024) + 'KB' + (isFinal ? ' (final)' : ''));
  }

  // ============================================================
  // 録音サイクル（Morning Hook startCycle準拠）
  // ============================================================
  function startCycle() {
    if (!recording || !audioStream) return;

    var mimeType = MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : MIME_FALLBACK;
    var currentIndex = chunkIndex++;
    var chunks = [];

    try {
      mediaRecorder = new MediaRecorder(audioStream, {
        mimeType: mimeType,
        audioBitsPerSecond: BITRATE,
      });
    } catch (e) {
      console.error(LOG, 'MediaRecorder作成失敗:', e.message);
      sendStatus('error', 'MediaRecorder作成失敗: ' + e.message);
      return;
    }

    mediaRecorder.ondataavailable = function (event) {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = function () {
      if (chunks.length === 0) {
        // 次サイクルへ
        if (recording) startCycle();
        return;
      }

      var blob = new Blob(chunks, { type: mimeType });
      var isFinal = !recording;

      blob.arrayBuffer().then(function (buffer) {
        sendChunk(buffer, currentIndex, isFinal);
      });

      // 再帰的に次サイクル開始
      if (recording) {
        startCycle();
      }
    };

    mediaRecorder.onerror = function (e) {
      console.error(LOG, 'MediaRecorderエラー:', e.error?.message || 'unknown');
    };

    mediaRecorder.start();

    // CHUNK_INTERVAL_MS後に停止 → ondataavailable → onstop
    setTimeout(function () {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, CHUNK_INTERVAL_MS);
  }

  // ============================================================
  // ビデオ要素をリトライ付きで検出
  // ============================================================
  function findVideoWithRetry(callback, retryCount) {
    retryCount = retryCount || 0;
    var video = findVideoElement();
    if (video) {
      callback(video);
      return;
    }
    if (retryCount >= FIND_VIDEO_MAX_RETRY) {
      console.warn(LOG, 'ビデオ要素が見つかりません（' + FIND_VIDEO_MAX_RETRY + '回リトライ済み）');
      sendStatus('error', 'ビデオ要素が見つかりません');
      return;
    }
    console.log(LOG, 'ビデオ要素検索リトライ (' + (retryCount + 1) + '/' + FIND_VIDEO_MAX_RETRY + ')');
    setTimeout(function () {
      findVideoWithRetry(callback, retryCount + 1);
    }, FIND_VIDEO_INTERVAL);
  }

  // ============================================================
  // キャプチャ開始
  // ============================================================
  function startCapture() {
    if (recording) {
      console.log(LOG, '既にキャプチャ中');
      return;
    }

    castName = extractCastName();
    if (!castName) {
      console.warn(LOG, 'キャスト名を取得できません — キャストページ以外');
      sendStatus('error', 'キャスト名を取得できません');
      return;
    }

    console.log(LOG, 'キャプチャ開始準備: cast=' + castName);
    sendStatus('searching', 'ビデオ要素を検索中...');

    findVideoWithRetry(function (video) {
      try {
        var fullStream = video.captureStream();
        var audioTracks = fullStream.getAudioTracks();

        if (audioTracks.length === 0) {
          console.warn(LOG, 'オーディオトラックがありません');
          sendStatus('error', 'オーディオトラックなし');
          return;
        }

        audioStream = new MediaStream(audioTracks);
        recording = true;
        chunkIndex = 0;

        console.log(LOG, 'Audio capture started: cast=' + castName + ' tracks=' + audioTracks.length);
        sendStatus('recording', 'キャプチャ中');

        startCycle();
      } catch (e) {
        console.error(LOG, 'captureStream失敗:', e.message);
        sendStatus('error', 'captureStream失敗: ' + e.message);
      }
    });
  }

  // ============================================================
  // キャプチャ停止
  // ============================================================
  function stopCapture() {
    recording = false;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop(); // onstop内で最終チャンク送信
    }

    if (audioStream) {
      audioStream.getTracks().forEach(function (t) { t.stop(); });
      audioStream = null;
    }

    mediaRecorder = null;
    console.log(LOG, 'Audio capture stopped: cast=' + castName);
    sendStatus('stopped', 'キャプチャ停止');
  }

  // ============================================================
  // 制御メッセージ受信（content_stt_relay.jsから）
  // ============================================================
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== CONTROL_TYPE) return;

    if (event.data.action === 'start') {
      startCapture();
    } else if (event.data.action === 'stop') {
      stopCapture();
    }
  });

  console.log(LOG, 'Content STT (MAIN world) loaded');
})();
