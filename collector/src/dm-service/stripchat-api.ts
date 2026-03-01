/**
 * Stripchat DM API Client
 *
 * Chrome拡張/Next.js API route のロジックをサーバーサイド常駐プロセス用に移植。
 * HTTP API経由でDM送信する。DOM操作フォールバックなし。
 */
import crypto from 'crypto';

// ============================================================
// Types
// ============================================================

export interface SessionData {
  id: string;
  account_id: string;
  session_cookie: string;
  csrf_token: string | null;
  csrf_timestamp: string | null;
  stripchat_user_id: string;
  front_version: string | null;
  cookies_json: Record<string, string>;
  jwt_token?: string | null;
}

interface CsrfInfo {
  token: string;
  timestamp: string;
  notifyTimestamp: string;
}

export interface DMResult {
  success: boolean;
  messageId?: string;
  error?: string;
  sessionExpired?: boolean;
}

export interface PhotoUploadResult {
  success: boolean;
  mediaId?: number;
  error?: string;
  sessionExpired?: boolean;
}

// ============================================================
// Constants
// ============================================================

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_FRONT_VERSION = '11.5.57';

// ============================================================
// API Client
// ============================================================

export class StripchatDMApi {
  private session: SessionData;

  constructor(session: SessionData) {
    this.session = session;
  }

  get stripchatUserId(): string {
    return this.session.stripchat_user_id;
  }

  get accountId(): string {
    return this.session.account_id;
  }

  private buildCookieString(): string {
    const cj = this.session.cookies_json;
    if (cj && Object.keys(cj).length > 0) {
      return Object.entries(cj).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return `stripchat_com_sessionId=${this.session.session_cookie}`;
  }

  async getCsrfToken(): Promise<CsrfInfo | null> {
    // 方法1: DB保存のCSRFトークン
    if (this.session.csrf_token) {
      const now = new Date();
      return {
        token: this.session.csrf_token,
        timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
          .toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
    }

    // 方法2: /api/front/v2/config からフェッチ
    try {
      const res = await fetch('https://ja.stripchat.com/api/front/v2/config', {
        headers: { Accept: 'application/json', Cookie: this.buildCookieString() },
      });
      if (res.ok) {
        const config = await res.json() as Record<string, unknown>;
        const inner = config?.config as Record<string, unknown> | undefined;
        const csrfToken = (config?.csrfToken as string) || (inner?.csrfToken as string) || null;
        if (csrfToken) {
          const now = new Date();
          return {
            token: csrfToken,
            timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
              .toISOString().replace(/\.\d{3}Z$/, 'Z'),
          };
        }
      }
    } catch { /* ignore */ }

    return null;
  }

  /**
   * username → Stripchat userId を解決
   */
  async resolveUserId(username: string): Promise<{ userId: string | null; error?: string }> {
    try {
      const res = await fetch(
        `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(username)}`,
        { headers: { Accept: 'application/json', Cookie: this.buildCookieString() } },
      );
      if (!res.ok) return { userId: null, error: `Stripchat API ${res.status}` };

      const data = await res.json() as Record<string, unknown>;
      const user = data?.user as Record<string, unknown> | undefined;
      const userId = user?.id ? String(user.id) : null;
      return userId ? { userId } : { userId: null, error: 'userId not in response' };
    } catch (err) {
      return { userId: null, error: String(err) };
    }
  }

  /**
   * テキストDM送信
   */
  async sendDM(
    targetUserId: string,
    message: string,
    targetUsername?: string,
    mediaOptions?: { mediaId: number; mediaSource?: string },
  ): Promise<DMResult> {
    const csrf = await this.getCsrfToken();
    if (!csrf) return { success: false, error: 'csrfToken取得失敗', sessionExpired: false };

    const uniq = crypto.randomBytes(12).toString('hex').slice(0, 16);
    const cookieStr = this.buildCookieString();

    const msgBody: Record<string, unknown> = {
      body: message,
      csrfToken: csrf.token,
      csrfTimestamp: csrf.timestamp,
      csrfNotifyTimestamp: csrf.notifyTimestamp,
      uniq,
    };
    if (mediaOptions) {
      msgBody.mediaId = mediaOptions.mediaId;
      msgBody.mediaSource = mediaOptions.mediaSource || 'upload';
      msgBody.platform = 'Web';
    }

    try {
      const res = await fetch(
        `https://ja.stripchat.com/api/front/users/${this.session.stripchat_user_id}/conversations/${targetUserId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookieStr,
            Origin: 'https://ja.stripchat.com',
            Referer: `https://ja.stripchat.com/user/${targetUsername || targetUserId}`,
            'User-Agent': USER_AGENT,
            'front-version': this.session.front_version || DEFAULT_FRONT_VERSION,
          },
          body: JSON.stringify(msgBody),
        },
      );

      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = data.message as Record<string, unknown> | undefined;

      if (res.ok && msg) {
        return { success: true, messageId: String(msg.id) };
      }

      if (res.status === 401 || res.status === 403) {
        return { success: false, error: JSON.stringify(data).slice(0, 500), sessionExpired: true };
      }

      return { success: false, error: JSON.stringify(data).slice(0, 500), sessionExpired: false };
    } catch (err) {
      return { success: false, error: String(err), sessionExpired: false };
    }
  }

  /**
   * 画像アップロード（DM添付用）
   */
  async uploadPhoto(imageBuffer: Buffer, filename: string = 'image.jpg'): Promise<PhotoUploadResult> {
    const csrf = await this.getCsrfToken();
    if (!csrf) return { success: false, error: 'csrfToken取得失敗', sessionExpired: false };

    const cookieStr = this.buildCookieString();
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' });

    const formData = new FormData();
    formData.append('photo', blob, filename);
    formData.append('source', 'upload');
    formData.append('messenger', '1');
    formData.append('csrfToken', csrf.token);
    formData.append('csrfTimestamp', csrf.timestamp);
    formData.append('csrfNotifyTimestamp', csrf.notifyTimestamp);

    try {
      const res = await fetch(
        `https://ja.stripchat.com/api/front/users/${this.session.stripchat_user_id}/albums/0/photos`,
        {
          method: 'POST',
          headers: {
            Cookie: cookieStr,
            Origin: 'https://ja.stripchat.com',
            Referer: 'https://ja.stripchat.com/',
            'User-Agent': USER_AGENT,
            'front-version': this.session.front_version || DEFAULT_FRONT_VERSION,
          },
          body: formData,
        },
      );

      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      const photo = data.photo as Record<string, unknown> | undefined;
      if (res.ok && photo?.id) return { success: true, mediaId: photo.id as number };
      if (res.status === 401 || res.status === 403) {
        return { success: false, error: JSON.stringify(data).slice(0, 500), sessionExpired: true };
      }
      return { success: false, error: JSON.stringify(data).slice(0, 500), sessionExpired: false };
    } catch (err) {
      return { success: false, error: String(err), sessionExpired: false };
    }
  }

  /**
   * セッション有効性テスト
   */
  async testConnection(): Promise<{ ok: boolean; status: number; cfBlocked: boolean }> {
    try {
      const res = await fetch('https://ja.stripchat.com/api/front/v2/config', {
        headers: { Cookie: this.buildCookieString(), 'User-Agent': USER_AGENT },
      });
      const cfBlocked = res.status === 403 || !!res.headers.get('cf-mitigated');
      return { ok: res.ok, status: res.status, cfBlocked };
    } catch {
      return { ok: false, status: 0, cfBlocked: false };
    }
  }
}
