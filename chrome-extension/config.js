/**
 * Strip Live Spot Chrome Extension - Configuration
 * background.js から importScripts('config.js') で読み込み
 */
const CONFIG = {
  API_BASE_URL: 'https://pseudofinally-glaiked-john.ngrok-free.dev',
  SUPABASE_URL: 'https://ujgbhkllfeacbgpdbjto.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ',
  POLL_INTERVAL: 3000,
  DM_SEND_TIMEOUT: 45000,
  SPY_BATCH_INTERVAL: 1000,
  // STT Configuration
  STT_CHUNK_INTERVAL: 5000,         // 5秒チャンク
  STT_MAX_QUEUE_SIZE: 10,           // キュー最大サイズ
  STT_API_ENDPOINT: '/api/stt/transcribe',
  PERSONA_API_URL: 'http://localhost:3000',
};
