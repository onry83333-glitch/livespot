/**
 * Normalizer — 入出力型定義
 *
 * collector → normalizer → supabase の3段パイプラインで使用。
 * Raw = パーサー出力（未検証）、Normalized = バリデーション通過済み。
 */

// ============================================================
// Message
// ============================================================

/** enqueue('spy_messages', row) に渡される生データ */
export interface RawMessage {
  account_id?: unknown;
  cast_name?: unknown;
  message_time?: unknown;
  msg_type?: unknown;
  user_name?: unknown;
  message?: unknown;
  tokens?: unknown;
  is_vip?: unknown;
  session_id?: unknown;
  user_league?: unknown;
  user_level?: unknown;
  metadata?: unknown;
}

/** バリデーション通過後の正規化メッセージ（enqueue() の Record<string, unknown> と互換） */
export interface NormalizedMessage {
  [key: string]: unknown;
  account_id: string;
  cast_name: string;
  message_time: string;
  msg_type: 'chat' | 'tip' | 'system';
  user_name: string;
  message: string;
  tokens: number;
  is_vip: boolean;
  session_id: string | null;
  user_league: string | null;
  user_level: number | null;
  metadata: Record<string, unknown>;
}

// ============================================================
// Viewer
// ============================================================

/** parseViewerList() 出力に近い生データ */
export interface RawViewer {
  userName?: unknown;
  userIdStripchat?: unknown;
  league?: unknown;
  level?: unknown;
  isFanClub?: unknown;
}

/** バリデーション通過後の正規化ビューアー */
export interface NormalizedViewer {
  userName: string;
  userIdStripchat: string;
  league: string;
  level: number;
  isFanClub: boolean;
  /** 今回のバッチ内で初出のユーザーか（重複排除後に計算） */
  isNew: boolean;
}

// ============================================================
// Session
// ============================================================

/** openSession() に渡される生データ */
export interface RawSession {
  sessionId?: unknown;
  accountId?: unknown;
  castName?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

/** バリデーション通過後の正規化セッション */
export interface NormalizedSession {
  sessionId: string;
  accountId: string;
  castName: string;
  startedAt: string;
  endedAt: string | null;
}
