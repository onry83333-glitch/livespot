// ============================================================
// SPY Tab 共通型定義
// ============================================================

export interface ViewerStat {
  total: number | null;
  coin_users: number | null;
  others: number | null;
  recorded_at: string;
}

// メッセージタイプフィルタ定義
export const MSG_TYPE_FILTERS = [
  { key: 'chat',    label: '💬 チャット', types: ['chat'] },
  { key: 'tip',     label: '🪙 チップ',   types: ['tip', 'gift', 'group_join', 'group_end'] },
  { key: 'speech',  label: '🎤 音声',     types: ['speech'] },
  { key: 'enter',   label: '🚪 入退室',   types: ['enter', 'leave'] },
  { key: 'system',  label: '⚙️ システム', types: ['goal', 'viewer_count', 'system'] },
] as const;

export type FilterKey = typeof MSG_TYPE_FILTERS[number]['key'];
