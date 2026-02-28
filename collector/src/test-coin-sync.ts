/**
 * coin-sync 手動テスト用スクリプト
 * Usage: npx tsx src/test-coin-sync.ts
 */

import 'dotenv/config';
import { runCoinSync } from './coin-sync.js';

console.log('=== coin-sync 手動テスト開始 ===');
console.log('STRIPCHAT_USERNAME:', process.env.STRIPCHAT_USERNAME ? '✅ 設定済み' : '❌ 未設定');
console.log('STRIPCHAT_PASSWORD:', process.env.STRIPCHAT_PASSWORD ? '✅ 設定済み' : '❌ 未設定');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '✅' : '❌');
console.log('');

runCoinSync()
  .then(() => {
    console.log('\n=== coin-sync 完了 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n=== coin-sync 失敗 ===', err);
    process.exit(1);
  });
