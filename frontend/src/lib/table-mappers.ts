/**
 * table-mappers.ts — chat_logs/user_profiles カラム名 → 旧SpyMessage/PaidUser形式への変換
 *
 * v2テーブル移行の互換レイヤー。
 * chat_logs のカラム名（username, message_type, timestamp）を
 * フロントエンドの SpyMessage 型（user_name, msg_type, message_time）にマッピングする。
 */

import type { SpyMessage } from '@/types';

/**
 * chat_logs テーブルの行を SpyMessage 型にマッピング
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapChatLog(row: any): SpyMessage {
  return {
    id: row.id,
    account_id: row.account_id,
    cast_name: row.cast_name,
    message_time: row.timestamp ?? row.message_time,
    msg_type: row.message_type ?? row.msg_type ?? 'chat',
    user_name: row.username ?? row.user_name ?? null,
    message: row.message ?? null,
    tokens: row.tokens ?? 0,
    is_vip: row.is_vip ?? row.metadata?.is_vip ?? false,
    user_color: row.user_color ?? row.metadata?.user_color ?? null,
    user_league: row.user_league ?? row.metadata?.user_league ?? null,
    user_level: row.user_level ?? row.metadata?.user_level ?? null,
    metadata: row.metadata ?? {},
    session_id: row.session_id ?? null,
    session_title: row.session_title ?? null,
    created_at: row.created_at,
  };
}

/**
 * user_profiles テーブルの行を旧 paid_users 互換形式にマッピング
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapUserProfile(row: any): {
  id: string;
  account_id: string;
  cast_name: string;
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
  first_payment_date: string | null;
  tx_count: number;
  segment: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    id: row.id,
    account_id: row.account_id,
    cast_name: row.cast_name,
    user_name: row.username ?? row.user_name,
    total_coins: row.total_tokens ?? row.total_coins ?? 0,
    last_payment_date: row.last_seen ?? row.last_payment_date ?? null,
    first_payment_date: row.first_seen ?? row.first_payment_date ?? null,
    tx_count: row.visit_count ?? row.tx_count ?? 0,
    segment: row.segment ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  };
}
