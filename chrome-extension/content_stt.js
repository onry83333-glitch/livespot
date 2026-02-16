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
 * v2: AudioContext fallback + キャスト名修正 + リトライ
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
  var AUDIO_RETRY_MAX = 5;             // 音声トラック検出リトライ回数
  var AUDIO_RETRY_INTERVAL = 2000;     // 音声トラック検出リトライ間隔

  var mediaRecorder = null;
  var audioStream = null;
  var audioContext = null;
  var recording = false;
  var castName = '';
  var chunkIndex = 0;

  // ============================================================
  // キャスト名抽出（URLパスから、言語プレフィックス対応）
  // ============================================================
  function extractCastName() {
    var path = location.pathname;
    // パスセグメントに分割: /ja/cast_name → ['ja', 'cast_name']
    var segments = path.split('/').filter(function(s) { return s.length > 0; });

    if (segments.length === 0) return '';

    // 言語プレフィックスのリスト
    var langPrefixes = [
      'ja', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ko', 'zh',
      'nl', 'pl', 'tr', 'sv', 'cs', 'hu', 'ro', 'el', 'th', 'vi',
      'ar', 'hi', 'id', 'ms', 'fi', 'da', 'no', 'uk', 'bg', 'hr',
    ];

    // 予約パス（キャストページではない）
    var reserved = [
      'user', 'favorites', 'settings', 'messages', 'earnings',
      'login', 'signup', 'search', 'categories', 'tags',
      'model', 'studio', 'privacy', 'terms', 'support',
    ];

    // 最初のセグメントが言語プレフィックスならスキップ
    var startIdx = 0;
    if (segments.length > 1 && langPrefixes.indexOf(segments[0].toLowerCase()) !== -1) {
      startIdx = 1;
    }

    // キャスト名候補
    var candidate = segments[startIdx];
    if (!candidate) return '';

    // 予約パスチェック
    if (reserved.indexOf(candidate.toLowerCase()) !== -1) return '';

    return decodeURIComponent(candidate);
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
  // 音声キャプチャ（2段階: captureStream → AudioContext fallback）
  // ============================================================
  function attemptAudioCapture(video, retryCount) {
    retryCount = retryCount || 0;

    // 診断ログ
    console.log(LOG, 'Video状態:', {
      src: (video.src || '').substring(0, 60),
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      readyState: video.readyState,
    });

    // === 方法1: captureStream ===
    try {
      var fullStream = video.captureStream();
      var audioTracks = fullStream.getAudioTracks();
      console.log(LOG, 'captureStream: audioTracks=' + audioTracks.length);

      if (audioTracks.length > 0) {
        audioStream = new MediaStream(audioTracks);
        recording = true;
        chunkIndex = 0;
        console.log(LOG, 'Audio capture started (captureStream): cast=' + castName + ' tracks=' + audioTracks.length);
        sendStatus('recording', 'キャプチャ中');
        startCycle();
        return;
      }
    } catch (e) {
      console.warn(LOG, 'captureStream失敗:', e.message);
    }

    // === 方法2: AudioContext + createMediaElementSource ===
    try {
      console.log(LOG, 'AudioContext fallback試行...');
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var source = ctx.createMediaElementSource(video);
      var dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      source.connect(ctx.destination); // スピーカー出力を維持

      var aTracks = dest.stream.getAudioTracks();
      console.log(LOG, 'AudioContext: audioTracks=' + aTracks.length);

      if (aTracks.length > 0) {
        audioStream = dest.stream;
        audioContext = ctx;
        recording = true;
        chunkIndex = 0;
        console.log(LOG, 'Audio capture started (AudioContext): cast=' + castName);
        sendStatus('recording', 'キャプチャ中 (AudioContext)');
        startCycle();
        return;
      }
    } catch (e) {
      console.warn(LOG, 'AudioContext fallback失敗:', e.message);
      // "already connected" エラーは想定内 — Stripchat側がAudioContext使用中
    }

    // === リトライ（音声トラックがまだロードされていない場合） ===
    if (retryCount < AUDIO_RETRY_MAX) {
      console.log(LOG, 'オーディオトラック未検出 — ' + AUDIO_RETRY_INTERVAL + 'msで再試行 (' + (retryCount + 1) + '/' + AUDIO_RETRY_MAX + ')');
      setTimeout(function () {
        attemptAudioCapture(video, retryCount + 1);
      }, AUDIO_RETRY_INTERVAL);
      return;
    }

    console.error(LOG, 'オーディオキャプチャ失敗（全方式）: captureStream + AudioContext + リトライ全て失敗');
    sendStatus('error', 'オーディオトラックを取得できません。配信音声が再生されているか確認してください。');
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
      console.warn(LOG, 'キャスト名を取得できません — キャストページ以外のため開始不可');
      sendStatus('error', 'キャストページを開いてください');
      return;
    }

    console.log(LOG, 'キャプチャ開始準備: cast=' + castName);
    sendStatus('searching', 'ビデオ要素を検索中...');

    findVideoWithRetry(function (video) {
      attemptAudioCapture(video, 0);
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

    if (audioContext) {
      try { audioContext.close(); } catch (e) { /* ignore */ }
      audioContext = null;
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
