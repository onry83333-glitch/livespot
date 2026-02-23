/**
 * Strip Live Spot Chrome Extension - Configuration
 * background.js から importScripts('config.js') で読み込み
 *
 * 環境判定: chrome.runtime.getManifest() に update_url があれば
 * Chrome Web Store 経由インストール = 本番。なければローカル開発。
 */
const CONFIG = (() => {
  const manifest = typeof chrome !== 'undefined' && chrome.runtime
    ? chrome.runtime.getManifest()
    : {};
  const isProd = 'update_url' in manifest;

  const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ';

  return {
    // --- 環境依存 ---
    API_BASE_URL: isProd
      ? 'https://livespot-api.onrender.com'
      : 'http://localhost:8000',
    PERSONA_API_URL: isProd
      ? 'https://livespot-rouge.vercel.app'
      : 'http://localhost:3000',

    // --- 共通 ---
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    POLL_INTERVAL: 3000,
    DM_SEND_TIMEOUT: 45000,
    SPY_BATCH_INTERVAL: 1000,

    // STT
    STT_CHUNK_INTERVAL: 5000,
    STT_MAX_QUEUE_SIZE: 10,
    STT_API_ENDPOINT: '/api/stt/transcribe',

    // デバッグ
    IS_PROD: isProd,
    DEBUG: !isProd,
  };
})();
