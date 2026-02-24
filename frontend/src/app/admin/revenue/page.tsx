'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth-provider';

// ============================================================
// Types
// ============================================================
interface RevenueShareRow {
  week_start: string;
  week_end: string;
  week_label: string;
  transaction_count: number;
  total_tokens: number;
  setting_token_to_usd: number;
  setting_platform_fee_pct: number;
  setting_revenue_share_pct: number;
  gross_usd: number;
  platform_fee_usd: number;
  net_usd: number;
  cast_payment_usd: number;
  formula_gross: string;
  formula_fee: string;
  formula_net: string;
  formula_payment: string;
}

interface CastOption {
  cast_name: string;
}

// ============================================================
// Helpers
// ============================================================
function formatUsd(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US') + ' tk';
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function exportCsv(rows: RevenueShareRow[], castName: string) {
  const headers = [
    '週', '開始日', '終了日', '取引数', '総トークン',
    'トークン単価(USD)', 'PF手数料率(%)', '分配率(%)',
    'グロス(USD)', 'PF手数料(USD)', 'ネット(USD)', 'キャスト支払い(USD)',
    '根拠:グロス', '根拠:手数料', '根拠:ネット', '根拠:支払い',
  ];
  const csvRows = rows.map(r => [
    r.week_label, r.week_start, r.week_end, r.transaction_count, r.total_tokens,
    r.setting_token_to_usd, r.setting_platform_fee_pct, r.setting_revenue_share_pct,
    r.gross_usd, r.platform_fee_usd, r.net_usd, r.cast_payment_usd,
    `"${r.formula_gross}"`, `"${r.formula_fee}"`, `"${r.formula_net}"`, `"${r.formula_payment}"`,
  ]);
  const bom = '\uFEFF';
  const csv = bom + [headers.join(','), ...csvRows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `revenue_share_${castName}_${toISODate(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// DATA_CUTOFF: 2/15 以前は使用禁止
const DATA_CUTOFF = '2025-02-15';

// ============================================================
// Component
// ============================================================
export default function RevenueSharePage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [casts, setCasts] = useState<CastOption[]>([]);
  const [selectedCast, setSelectedCast] = useState('');
  const [startDate, setStartDate] = useState(() => DATA_CUTOFF);
  const [endDate, setEndDate] = useState(() => toISODate(new Date()));
  const [rows, setRows] = useState<RevenueShareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedWeek, setExpandedWeek] = useState<string | null>(null);

  // accountId 取得
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').eq('user_id', user.id).limit(1).single()
      .then(({ data }) => {
        if (data) setAccountId(data.id);
      });
  }, [user, sb]);

  // キャスト一覧取得
  useEffect(() => {
    if (!accountId) return;
    sb.from('registered_casts')
      .select('cast_name')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('cast_name')
      .then(({ data }) => {
        if (data && data.length > 0) {
          setCasts(data);
          if (!selectedCast) setSelectedCast(data[0].cast_name);
        }
      });
  }, [accountId, sb, selectedCast]);

  // 計算実行
  const calculate = useCallback(async () => {
    if (!accountId || !selectedCast) return;
    setLoading(true);
    setError('');
    setRows([]);

    // startDate が DATA_CUTOFF 以前なら強制補正
    const safeStart = startDate < DATA_CUTOFF ? DATA_CUTOFF : startDate;

    const { data, error: rpcErr } = await sb.rpc('calculate_revenue_share', {
      p_account_id: accountId,
      p_cast_name: selectedCast,
      p_start_date: safeStart,
      p_end_date: endDate,
    });

    setLoading(false);

    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    if (!data || data.length === 0) {
      setError('該当期間にデータがありません');
      return;
    }

    setRows(data as RevenueShareRow[]);
  }, [accountId, selectedCast, startDate, endDate, sb]);

  // 合計行
  const totals = rows.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.total_tokens,
      txCount: acc.txCount + r.transaction_count,
      gross: acc.gross + r.gross_usd,
      fee: acc.fee + r.platform_fee_usd,
      net: acc.net + r.net_usd,
      payment: acc.payment + r.cast_payment_usd,
    }),
    { tokens: 0, txCount: 0, gross: 0, fee: 0, net: 0, payment: 0 },
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      {/* ヘッダー */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          レベニューシェア計算
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          週次・月曜03:00 JST 境界 / coin_transactions.tokens ベース / 2/15以降のみ
        </p>
      </div>

      {/* フィルタバー */}
      <div className="glass-card p-4 flex flex-wrap gap-4 items-end">
        {/* キャスト選択 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--text-muted)]">キャスト</label>
          <select
            className="input-glass px-3 py-2 min-w-[180px]"
            value={selectedCast}
            onChange={e => setSelectedCast(e.target.value)}
          >
            {casts.map(c => (
              <option key={c.cast_name} value={c.cast_name}>{c.cast_name}</option>
            ))}
          </select>
        </div>

        {/* 開始日 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--text-muted)]">開始日</label>
          <input
            type="date"
            className="input-glass px-3 py-2"
            value={startDate}
            min={DATA_CUTOFF}
            onChange={e => setStartDate(e.target.value)}
          />
        </div>

        {/* 終了日 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--text-muted)]">終了日</label>
          <input
            type="date"
            className="input-glass px-3 py-2"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
          />
        </div>

        {/* 計算ボタン */}
        <button
          className="btn-primary px-6 py-2"
          onClick={calculate}
          disabled={loading || !selectedCast}
        >
          {loading ? '計算中...' : '計算する'}
        </button>

        {/* CSVエクスポート */}
        {rows.length > 0 && (
          <button
            className="btn-ghost px-4 py-2"
            onClick={() => exportCsv(rows, selectedCast)}
          >
            CSV出力
          </button>
        )}
      </div>

      {/* エラー */}
      {error && (
        <div className="glass-card p-4 border border-rose-500/30 text-rose-400 text-sm">
          {error}
        </div>
      )}

      {/* データ切り捨て警告 */}
      {startDate < DATA_CUTOFF && (
        <div className="glass-card p-3 border border-amber-500/30 text-amber-400 text-sm">
          2025/2/15 以前のデータは使用禁止のため、{DATA_CUTOFF} 以降で計算されます。
        </div>
      )}

      {/* 結果テーブル */}
      {rows.length > 0 && (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[var(--text-muted)] text-xs">
                <th className="text-left p-3">週</th>
                <th className="text-right p-3">取引数</th>
                <th className="text-right p-3">総トークン</th>
                <th className="text-right p-3">グロス (USD)</th>
                <th className="text-right p-3">PF手数料 (USD)</th>
                <th className="text-right p-3">ネット (USD)</th>
                <th className="text-right p-3 text-sky-400">キャスト支払い</th>
                <th className="text-center p-3">根拠</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <>
                  <tr
                    key={r.week_start}
                    className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="p-3 text-[var(--text-primary)] font-mono text-xs">
                      {r.week_label}
                    </td>
                    <td className="p-3 text-right text-[var(--text-secondary)]">
                      {r.transaction_count.toLocaleString()}
                    </td>
                    <td className="p-3 text-right text-[var(--text-primary)] font-mono">
                      {formatTokens(r.total_tokens)}
                    </td>
                    <td className="p-3 text-right text-[var(--text-secondary)] font-mono">
                      {formatUsd(r.gross_usd)}
                    </td>
                    <td className="p-3 text-right text-rose-400/80 font-mono">
                      -{formatUsd(r.platform_fee_usd)}
                    </td>
                    <td className="p-3 text-right text-[var(--text-primary)] font-mono">
                      {formatUsd(r.net_usd)}
                    </td>
                    <td className="p-3 text-right text-sky-400 font-bold font-mono">
                      {formatUsd(r.cast_payment_usd)}
                    </td>
                    <td className="p-3 text-center">
                      <button
                        className="text-xs text-[var(--text-muted)] hover:text-sky-400 transition-colors"
                        onClick={() => setExpandedWeek(
                          expandedWeek === r.week_start ? null : r.week_start
                        )}
                      >
                        {expandedWeek === r.week_start ? '閉じる' : '表示'}
                      </button>
                    </td>
                  </tr>
                  {/* 演算根拠展開 */}
                  {expandedWeek === r.week_start && (
                    <tr key={r.week_start + '-detail'}>
                      <td colSpan={8} className="p-0">
                        <div className="bg-white/[0.02] border-t border-b border-sky-500/10 p-4 space-y-2">
                          <div className="text-xs text-[var(--text-muted)] mb-2">
                            設定値: トークン単価 = ${r.setting_token_to_usd} /
                            PF手数料率 = {r.setting_platform_fee_pct}% /
                            分配率 = {r.setting_revenue_share_pct}%
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
                            <div className="glass-panel p-2">
                              <span className="text-[var(--text-muted)]">1. グロス: </span>
                              <span className="text-[var(--text-primary)]">{r.formula_gross}</span>
                            </div>
                            <div className="glass-panel p-2">
                              <span className="text-[var(--text-muted)]">2. PF手数料: </span>
                              <span className="text-rose-400/80">{r.formula_fee}</span>
                            </div>
                            <div className="glass-panel p-2">
                              <span className="text-[var(--text-muted)]">3. ネット: </span>
                              <span className="text-[var(--text-primary)]">{r.formula_net}</span>
                            </div>
                            <div className="glass-panel p-2">
                              <span className="text-[var(--text-muted)]">4. キャスト支払い: </span>
                              <span className="text-sky-400 font-bold">{r.formula_payment}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>

            {/* 合計行 */}
            <tfoot>
              <tr className="border-t-2 border-sky-500/20 bg-white/[0.03] font-bold">
                <td className="p-3 text-[var(--text-primary)]">合計</td>
                <td className="p-3 text-right text-[var(--text-secondary)]">
                  {totals.txCount.toLocaleString()}
                </td>
                <td className="p-3 text-right text-[var(--text-primary)] font-mono">
                  {formatTokens(totals.tokens)}
                </td>
                <td className="p-3 text-right text-[var(--text-secondary)] font-mono">
                  {formatUsd(totals.gross)}
                </td>
                <td className="p-3 text-right text-rose-400/80 font-mono">
                  -{formatUsd(totals.fee)}
                </td>
                <td className="p-3 text-right text-[var(--text-primary)] font-mono">
                  {formatUsd(totals.net)}
                </td>
                <td className="p-3 text-right text-sky-400 font-mono text-base">
                  {formatUsd(totals.payment)}
                </td>
                <td className="p-3 text-center text-xs text-[var(--text-muted)]">
                  {rows.length}週
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 合計カード（全根拠付き） */}
      {rows.length > 0 && (
        <div className="glass-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            期間合計の演算根拠
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm font-mono">
            <div className="glass-panel p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">1. グロス売上</div>
              <div className="text-[var(--text-primary)]">
                {totals.tokens.toLocaleString()} tk x ${rows[0]?.setting_token_to_usd ?? 0.05}
              </div>
              <div className="text-lg font-bold text-[var(--text-primary)]">
                = {formatUsd(totals.gross)}
              </div>
            </div>
            <div className="glass-panel p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">2. PF手数料</div>
              <div className="text-rose-400/80">
                {formatUsd(totals.gross)} x {rows[0]?.setting_platform_fee_pct ?? 40}%
              </div>
              <div className="text-lg font-bold text-rose-400">
                = -{formatUsd(totals.fee)}
              </div>
            </div>
            <div className="glass-panel p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">3. ネット売上</div>
              <div className="text-[var(--text-primary)]">
                {formatUsd(totals.gross)} - {formatUsd(totals.fee)}
              </div>
              <div className="text-lg font-bold text-[var(--text-primary)]">
                = {formatUsd(totals.net)}
              </div>
            </div>
            <div className="glass-panel p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">4. キャスト支払い</div>
              <div className="text-sky-400">
                {formatUsd(totals.net)} x {rows[0]?.setting_revenue_share_pct ?? 50}%
              </div>
              <div className="text-xl font-bold text-sky-400">
                = {formatUsd(totals.payment)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 空状態 */}
      {!loading && rows.length === 0 && !error && (
        <div className="glass-card p-8 text-center text-[var(--text-muted)]">
          <p>キャストと期間を選択して「計算する」を押してください。</p>
          <p className="text-xs mt-2">
            ※ cast_cost_settings に該当キャストの設定が必要です
            （revenue_share_rate, platform_fee_rate, token_to_usd）
          </p>
        </div>
      )}
    </div>
  );
}
