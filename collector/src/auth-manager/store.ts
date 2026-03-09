/**
 * Auth Store — 認証状態管理 + ファイル永続化
 *
 * メモリ + .auth/current.json の2層管理。
 * HTTPサーバーとリフレッシュループから共有される。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.resolve(__dirname, '../../.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'current.json');

export interface AuthData {
  jwt: string;
  cfClearance: string;
  wsUrl: string;
  userId: string;
  expiresAt: number;       // Unix seconds
  method: string;
  acquiredAt: string;      // ISO timestamp
  refreshCount: number;
}

let current: AuthData | null = null;

/** 残りの有効秒数 */
export function remainingSeconds(): number {
  if (!current) return 0;
  return Math.max(0, current.expiresAt - Math.floor(Date.now() / 1000));
}

/** 認証が有効か（marginSec 以上の残り時間があるか） */
export function isValid(marginSec = 0): boolean {
  return remainingSeconds() > marginSec;
}

/** 現在の認証データを取得 */
export function get(): AuthData | null {
  return current;
}

/** 認証データを更新 + ファイル永続化 */
export function set(auth: AuthData): void {
  current = auth;
  persist();
}

/** ファイルから復元（起動時） */
export function restore(): AuthData | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
    const data = JSON.parse(raw) as AuthData;
    // 期限切れなら無視
    if (data.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    current = data;
    return data;
  } catch {
    return null;
  }
}

/** ファイルに保存 */
function persist(): void {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(current, null, 2), 'utf-8');
  } catch (err) {
    console.error('[auth-manager] Failed to persist auth:', err);
  }
}

/** キャッシュクリア */
export function invalidate(): void {
  current = null;
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch { /* ignore */ }
}
