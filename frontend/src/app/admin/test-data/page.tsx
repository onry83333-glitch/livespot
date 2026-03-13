'use client';

import { useState, useCallback, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';

/* ============================================================
   Types
   ============================================================ */
interface TableInfo {
  id: string;
  table: string;
  label: string;
  description: string;
  icon: string;
}

interface CountResult {
  table_name: string;
  total_count: number;
  breakdown: { prefix: string; count: number }[];
}

interface DeleteResult {
  table_name: string;
  deleted_count: number;
}

/* ============================================================
   Config — 対象テーブル定義
   ============================================================ */
const TARGET_TABLES: TableInfo[] = [
  {
    id: 'dm_send_log',
    table: 'dm_send_log',
    label: 'DM送信ログ',
    description: 'campaign が bulk_*, pipe3_bulk_*, 20250217_test_*, test_* のレコード',
    icon: '📨',
  },
  {
    id: 'chat_logs',
    table: 'chat_logs',
    label: 'SPYメッセージ',
    description: 'message_type = demo のデモ挿入データ',
    icon: '💬',
  },
  {
    id: 'dm_trigger_logs',
    table: 'dm_trigger_logs',
    label: 'DMトリガーログ',
    description: 'status = error の失敗ログ',
    icon: '⚡',
  },
];

/* ============================================================
   Page
   ============================================================ */
export default function TestDataPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, CountResult | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [deleteResults, setDeleteResults] = useState<Record<string, DeleteResult | null>>({});
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // アカウントID取得
  const ensureAccountId = useCallback(async (): Promise<string | null> => {
    if (accountId) return accountId;
    if (!user) return null;

    const { data } = await sb
      .from('accounts')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (data?.id) {
      setAccountId(data.id);
      return data.id;
    }
    setError('アカウントが見つかりません');
    return null;
  }, [accountId, user, sb]);

  // 件数カウント
  const countTable = useCallback(async (tableName: string) => {
    const aid = await ensureAccountId();
    if (!aid) return;

    setLoading(prev => ({ ...prev, [tableName]: true }));
    setError(null);

    try {
      const { data, error: rpcError } = await sb.rpc('count_test_data', {
        p_account_id: aid,
        p_table_name: tableName,
      });

      if (rpcError) throw rpcError;
      setCounts(prev => ({ ...prev, [tableName]: data as CountResult }));
      // カウントしたら前回の削除結果をクリア
      setDeleteResults(prev => ({ ...prev, [tableName]: null }));
    } catch (e) {
      setError(`${tableName} のカウントに失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(prev => ({ ...prev, [tableName]: false }));
    }
  }, [ensureAccountId, sb]);

  // 全テーブルカウント
  const countAll = useCallback(async () => {
    for (const t of TARGET_TABLES) {
      await countTable(t.table);
    }
  }, [countTable]);

  // 削除実行
  const deleteTable = useCallback(async (tableName: string) => {
    const aid = await ensureAccountId();
    if (!aid) return;

    setDeleting(prev => ({ ...prev, [tableName]: true }));
    setConfirmTarget(null);
    setError(null);

    try {
      const { data, error: rpcError } = await sb.rpc('delete_test_data', {
        p_account_id: aid,
        p_table_name: tableName,
      });

      if (rpcError) throw rpcError;
      setDeleteResults(prev => ({ ...prev, [tableName]: data as DeleteResult }));
      // カウントをリフレッシュ
      setCounts(prev => ({ ...prev, [tableName]: null }));
    } catch (e) {
      setError(`${tableName} の削除に失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(prev => ({ ...prev, [tableName]: false }));
    }
  }, [ensureAccountId, sb]);

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            テストデータ管理
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            開発・テストで生成されたデータを一括削除
          </p>
        </div>
        <button
          onClick={countAll}
          disabled={Object.values(loading).some(Boolean)}
          className="btn-primary px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50"
        >
          全テーブルをスキャン
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="glass-card p-4 border-l-4" style={{ borderLeftColor: 'var(--accent-pink)' }}>
          <p className="text-sm" style={{ color: 'var(--accent-pink)' }}>{error}</p>
        </div>
      )}

      {/* Table Cards */}
      <div className="space-y-4">
        {TARGET_TABLES.map(t => {
          const count = counts[t.table];
          const isLoading = loading[t.table];
          const isDeleting = deleting[t.table];
          const deleteResult = deleteResults[t.table];
          const isConfirming = confirmTarget === t.table;

          return (
            <div key={t.id} className="glass-card p-5">
              <div className="flex items-start justify-between gap-4">
                {/* Left: Table info */}
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xl">{t.icon}</span>
                    <div>
                      <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                        {t.label}
                      </h3>
                      <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                        {t.table}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                    {t.description}
                  </p>

                  {/* Count result */}
                  {count && (
                    <div className="glass-panel p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-bold" style={{
                          color: count.total_count > 0 ? 'var(--accent-amber)' : 'var(--accent-green)',
                        }}>
                          {(count.total_count ?? 0).toLocaleString()}
                        </span>
                        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                          件のテストデータ
                        </span>
                      </div>
                      {count.breakdown.length > 0 && (
                        <div className="space-y-1">
                          {count.breakdown.map((b, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                                {b.prefix}
                              </span>
                              <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                                {(b.count ?? 0).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delete result */}
                  {deleteResult && (
                    <div className="glass-panel p-3 mt-2 border-l-2" style={{ borderLeftColor: 'var(--accent-green)' }}>
                      <p className="text-sm" style={{ color: 'var(--accent-green)' }}>
                        {(deleteResult.deleted_count ?? 0).toLocaleString()} 件を削除しました
                      </p>
                    </div>
                  )}
                </div>

                {/* Right: Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => countTable(t.table)}
                    disabled={isLoading || isDeleting}
                    className="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                  >
                    {isLoading ? '集計中...' : '件数を確認'}
                  </button>

                  {isConfirming ? (
                    <div className="glass-panel p-3 space-y-2 min-w-[160px]">
                      <p className="text-xs font-bold" style={{ color: 'var(--accent-pink)' }}>
                        {(count?.total_count ?? 0).toLocaleString()} 件を削除しますか？
                      </p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        この操作は元に戻せません
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => deleteTable(t.table)}
                          className="btn-danger px-3 py-1.5 rounded-lg text-xs font-medium flex-1"
                        >
                          削除する
                        </button>
                        <button
                          onClick={() => setConfirmTarget(null)}
                          className="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium flex-1"
                        >
                          やめる
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        if (!count) {
                          // まだカウントしていない場合は先にカウント
                          countTable(t.table);
                          return;
                        }
                        if (count.total_count === 0) return;
                        setConfirmTarget(t.table);
                      }}
                      disabled={isLoading || isDeleting || (count !== undefined && count !== null && count.total_count === 0)}
                      className="btn-danger px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    >
                      {isDeleting ? '削除中...' : 'テストデータを削除'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Info */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
          テストデータの識別ルール
        </h3>
        <ul className="space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <li>
            <span className="font-mono" style={{ color: 'var(--accent-primary)' }}>dm_send_log</span>
            {' — campaign が '}
            <span className="font-mono">bulk_*</span>, <span className="font-mono">pipe3_bulk_*</span>,
            {' '}<span className="font-mono">20250217_test_*</span>, <span className="font-mono">test_*</span>
          </li>
          <li>
            <span className="font-mono" style={{ color: 'var(--accent-primary)' }}>chat_logs</span>
            {' — message_type = demo（デモ挿入データ）'}
          </li>
          <li>
            <span className="font-mono" style={{ color: 'var(--accent-primary)' }}>dm_trigger_logs</span>
            {' — status = error（トリガー発火エラー）'}
          </li>
        </ul>
      </div>
    </div>
  );
}
