import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ============================================================
// Types
// ============================================================

export interface StripchatSessionData {
  id: string;
  session_cookie: string;
  csrf_token: string | null;
  csrf_timestamp: string | null;
  stripchat_user_id: string | null;
  front_version: string | null;
  cookies_json: Record<string, string>;
  jwt_token?: string | null;
}

export interface CsrfInfo {
  token: string;
  timestamp: string;
  notifyTimestamp: string;
}

export interface ModelInfo {
  userId: string;
  status: string;
  viewersCount: number;
  snapshotTimestamp: number;
}

export interface ViewerMember {
  userId: string;
  username: string;
  league: string | null;
  level: number | null;
  isFanClub: boolean;
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

export interface ConnectionTestResult {
  ok: boolean;
  status: number;
  cfBlocked: boolean;
}

// ============================================================
// Constants
// ============================================================

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_FRONT_VERSION = '11.5.57';

// ============================================================
// StripchatAPI クラス
// ============================================================

export class StripchatAPI {
  private session: StripchatSessionData;

  constructor(session: StripchatSessionData) {
    this.session = session;
  }

  // ----------------------------------------------------------
  // buildCookieString — Cookie ヘッダー文字列を構築
  // ----------------------------------------------------------
  buildCookieString(): string {
    const cj = this.session.cookies_json;
    if (cj && Object.keys(cj).length > 0) {
      return Object.entries(cj)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
    return `stripchat_com_sessionId=${this.session.session_cookie}`;
  }

  // ----------------------------------------------------------
  // getCsrfToken — CSRF トークンを取得（キャッシュ or /config API）
  // ----------------------------------------------------------
  async getCsrfToken(): Promise<CsrfInfo | null> {
    // 方法1: 保存済み csrf_token を使用
    if (this.session.csrf_token) {
      const now = new Date();
      return {
        token: this.session.csrf_token,
        timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
      };
    }

    // 方法2: /api/front/v2/config から取得
    try {
      const cookieStr = this.buildCookieString();

      const configRes = await fetch(
        'https://ja.stripchat.com/api/front/v2/config',
        {
          headers: {
            Accept: 'application/json',
            Cookie: cookieStr,
          },
        },
      );
      if (configRes.ok) {
        const config = await configRes.json();
        const csrfToken =
          config?.csrfToken || config?.config?.csrfToken || null;
        if (csrfToken) {
          const now = new Date();
          return {
            token: csrfToken,
            timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
              .toISOString()
              .replace(/\.\d{3}Z$/, 'Z'),
          };
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  // ----------------------------------------------------------
  // resolveUserId — username → Stripchat userId 解決
  //   paid_users キャッシュ → Stripchat API フォールバック
  // ----------------------------------------------------------
  async resolveUserId(
    username: string,
    supabase: SupabaseClient,
    accountId?: string,
    castName?: string,
  ): Promise<{ userId: string | null; error?: string }> {
    // 1. paid_users キャッシュ確認
    let query = supabase
      .from('paid_users')
      .select('user_id_stripchat')
      .eq('user_name', username)
      .not('user_id_stripchat', 'is', null);
    if (accountId) query = query.eq('account_id', accountId);
    if (castName) query = query.eq('cast_name', castName);
    const { data: cached } = await query
      .limit(1)
      .maybeSingle();

    if (
      (cached as Record<string, unknown>)?.user_id_stripchat
    ) {
      return {
        userId: (cached as Record<string, unknown>)
          .user_id_stripchat as string,
      };
    }

    // 2. Stripchat API で解決
    try {
      const res = await fetch(
        `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(username)}`,
        {
          headers: {
            Accept: 'application/json',
            Cookie: `stripchat_com_sessionId=${this.session.session_cookie}`,
          },
        },
      );
      if (!res.ok) {
        return { userId: null, error: `Stripchat API ${res.status}` };
      }
      const data = await res.json();
      const userId = data?.user?.id ? String(data.user.id) : null;
      if (!userId) {
        return { userId: null, error: 'userId not found in response' };
      }

      // キャッシュ保存（ベストエフォート）
      let updateQuery = supabase
        .from('paid_users')
        .update({ user_id_stripchat: userId } as Record<string, unknown>)
        .eq('user_name', username);
      if (accountId) updateQuery = updateQuery.eq('account_id', accountId);
      if (castName) updateQuery = updateQuery.eq('cast_name', castName);
      await updateQuery.then(() => {});

      return { userId };
    } catch (err) {
      return { userId: null, error: String(err) };
    }
  }

  // ----------------------------------------------------------
  // sendDM — Stripchat DM API でメッセージ送信
  // ----------------------------------------------------------
  async sendDM(
    targetUserId: string,
    message: string,
    targetUsername?: string,
    mediaOptions?: { mediaId: number; mediaSource?: string },
  ): Promise<DMResult> {
    const csrf = await this.getCsrfToken();
    if (!csrf) {
      return {
        success: false,
        error: 'csrfToken取得失敗',
        sessionExpired: false,
      };
    }

    const uniq = crypto.randomBytes(12).toString('hex').slice(0, 16);
    const cookieStr = this.buildCookieString();
    const refererUser = targetUsername || targetUserId;

    // メッセージbody構築（画像パラメータがある場合は追加）
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
            Referer: `https://ja.stripchat.com/user/${refererUser}`,
            'User-Agent': USER_AGENT,
            'front-version':
              this.session.front_version || DEFAULT_FRONT_VERSION,
          },
          body: JSON.stringify(msgBody),
        },
      );

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.message) {
        return {
          success: true,
          messageId: String(data.message.id),
        };
      }

      // セッション期限切れ判定
      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          error: JSON.stringify(data).slice(0, 500),
          sessionExpired: true,
        };
      }

      return {
        success: false,
        error: JSON.stringify(data).slice(0, 500),
        sessionExpired: false,
      };
    } catch (err) {
      return {
        success: false,
        error: String(err),
        sessionExpired: false,
      };
    }
  }

  // ----------------------------------------------------------
  // uploadPhoto — DM用画像をStripchatにアップロード
  // ----------------------------------------------------------
  async uploadPhoto(
    photoBlob: Blob,
    filename: string = 'image.jpg',
  ): Promise<PhotoUploadResult> {
    const csrf = await this.getCsrfToken();
    if (!csrf) {
      return {
        success: false,
        error: 'csrfToken取得失敗',
        sessionExpired: false,
      };
    }

    const cookieStr = this.buildCookieString();

    const formData = new FormData();
    formData.append('photo', photoBlob, filename);
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
            'front-version':
              this.session.front_version || DEFAULT_FRONT_VERSION,
          },
          body: formData,
        },
      );

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.photo?.id) {
        return {
          success: true,
          mediaId: data.photo.id,
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          success: false,
          error: JSON.stringify(data).slice(0, 500),
          sessionExpired: true,
        };
      }

      return {
        success: false,
        error: JSON.stringify(data).slice(0, 500),
        sessionExpired: false,
      };
    } catch (err) {
      return {
        success: false,
        error: String(err),
        sessionExpired: false,
      };
    }
  }

  // ----------------------------------------------------------
  // getModelInfo — モデル情報取得（サムネイル・ステータス等）
  // ----------------------------------------------------------
  async getModelInfo(username: string): Promise<ModelInfo | null> {
    try {
      const res = await fetch(
        `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(username)}/cam`,
        {
          headers: {
            Accept: 'application/json',
          },
        },
      );
      if (!res.ok) return null;

      const data = await res.json();
      const user = data?.user;
      if (!user?.id) return null;

      return {
        userId: String(user.id),
        status: user.status || 'unknown',
        viewersCount: user.viewersCount ?? 0,
        snapshotTimestamp: user.snapshotTimestamp ?? 0,
      };
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------
  // getViewerMembers — 配信中のグループショーメンバー一覧取得
  // ----------------------------------------------------------
  async getViewerMembers(
    castUsername: string,
  ): Promise<ViewerMember[]> {
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Cookie: this.buildCookieString(),
      };

      // jwt_token がある場合は Authorization ヘッダーを追加
      if (this.session.jwt_token) {
        headers['Authorization'] = `Bearer ${this.session.jwt_token}`;
      }

      const res = await fetch(
        `https://stripchat.com/api/front/models/username/${encodeURIComponent(castUsername)}/groupShow/members`,
        { headers },
      );
      if (!res.ok) return [];

      const data = await res.json();
      const members = Array.isArray(data) ? data : data?.members ?? [];

      return members.map(
        (m: Record<string, unknown>): ViewerMember => ({
          userId: String(m.userId ?? m.id ?? ''),
          username: String(m.username ?? m.name ?? ''),
          league: (m.league as string) ?? null,
          level: typeof m.level === 'number' ? m.level : null,
          isFanClub: Boolean(m.isFanClub ?? m.fanClubMember ?? false),
        }),
      );
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------
  // testConnection — セッション接続テスト（Cloudflare ブロック検出）
  // ----------------------------------------------------------
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await fetch(
        'https://ja.stripchat.com/api/front/v2/config',
        {
          headers: {
            Cookie: this.buildCookieString(),
            'User-Agent': USER_AGENT,
          },
        },
      );

      // Cloudflare ブロック検出
      let cfBlocked = false;
      if (res.status === 403) {
        cfBlocked = true;
      }
      const cfMitigated = res.headers.get('cf-mitigated');
      if (cfMitigated) {
        cfBlocked = true;
      }

      // 403 かつ HTML レスポンスの場合、body に "cf-" が含まれるか確認
      if (res.status === 403 || !res.ok) {
        try {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('text/html')) {
            const body = await res.text();
            if (body.includes('cf-')) {
              cfBlocked = true;
            }
          }
        } catch {
          // body 読み取り失敗は無視
        }
      }

      return {
        ok: res.ok,
        status: res.status,
        cfBlocked,
      };
    } catch {
      return {
        ok: false,
        status: 0,
        cfBlocked: false,
      };
    }
  }
}
