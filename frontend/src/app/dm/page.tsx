'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/components/auth-provider';

import { createClient } from '@/lib/supabase/client';
import { tokensToJPY } from '@/lib/utils';

/* ============================================================
   Types
   ============================================================ */
interface DMLogItem {
  id: number;
  user_name: string;
  message: string | null;
  status: string;
  error: string | null;
  campaign: string;
  queued_at: string;
  sent_at: string | null;
}

interface NewWhale {
  user_name: string;
  total_tokens: number;
  first_paid: string;
  already_dm_sent: boolean;
}

interface Account {
  id: string;
  account_name: string;
}

/* ============================================================
   Page
   ============================================================ */
export default function DmPage() {
  const { user } = useAuth();

  const [tab, setTab] = useState<'bulk' | 'thank'>('bulk');

  // === 共通 ===
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  // === 一斉送信 state ===
  const [targetsText, setTargetsText] = useState(
    'https://ja.stripchat.com/user/p_yutayuta_p\nhttps://ja.stripchat.com/user/Nekomeem34\nhttps://ja.stripchat.com/user/kantou1234\nhttps://ja.stripchat.com/user/pojipojipoji'
  );
  const [message, setMessage] = useState('お久しぶりです！今夜空いてますか？またお話しできたら嬉しいです！');
  const [sendOrder, setSendOrder] = useState<'text-image' | 'image-text' | 'text-only'>('text-image');
  const [accessImage, setAccessImage] = useState<'free' | 'paid'>('free');
  const [sendMode, setSendMode] = useState<'sequential' | 'pipeline'>('pipeline');
  const [tabs, setTabs] = useState(3);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [statusCounts, setStatusCounts] = useState({ total: 0, queued: 0, sending: 0, success: 0, error: 0 });
  const [recentLogs, setRecentLogs] = useState<DMLogItem[]>([]);

  // === お礼DM state ===
  const [thankPeriod, setThankPeriod] = useState<'1' | '3' | '7'>('1');
  const [thankMinCoins, setThankMinCoins] = useState(100);
  const [whales, setWhales] = useState<NewWhale[]>([]);
  const [whaleChecked, setWhaleChecked] = useState<Set<string>>(new Set());
  const [whaleLoading, setWhaleLoading] = useState(false);
  const [whaleError, setWhaleError] = useState<string | null>(null);
  const [thankMessage, setThankMessage] = useState(
    '{username}さん、昨日は応援ありがとうございました！とっても嬉しかったです\u{1F495} また遊びに来てくださいね！'
  );
  const [thankSending, setThankSending] = useState(false);
  const [thankResult, setThankResult] = useState<{ queued: number; batch_id: string } | null>(null);

  const targets = targetsText.split('\n').map(t => t.trim()).filter(Boolean);

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id, account_name').order('created_at').then(({ data }) => {
      const list = data || [];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user, sb]);

  // === 一斉送信ロジック ===
  const pollStatus = useCallback(async (bid: string) => {
    try {
      const { data: items } = await sb.from('dm_send_log')
        .select('*')
        .eq('campaign', bid)
        .order('created_at', { ascending: false });
      const logs = items || [];
      const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
      logs.forEach(l => {
        if (l.status in counts) (counts as any)[l.status]++;
      });
      setStatusCounts(counts);
      setRecentLogs(logs.map(l => ({
        id: l.id, user_name: l.user_name, message: l.message,
        status: l.status, error: l.error, campaign: l.campaign,
        queued_at: l.queued_at || l.created_at, sent_at: l.sent_at,
      })));
    } catch { /* ignore */ }
  }, [sb]);

  useEffect(() => {
    if (!user) return;
    const channel = sb
      .channel('dm-status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log' }, () => {
        if (batchId) pollStatus(batchId);
      })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [user, batchId, pollStatus, sb]);

  const handleSend = async () => {
    if (targets.length === 0) { setError('ターゲットを1件以上入力してください'); return; }
    if (!message.trim()) { setError('メッセージを入力してください'); return; }
    if (!selectedAccount) { setError('アカウントを選択してください'); return; }
    setSending(true); setError(null); setBatchId(null);
    try {
      // ターゲットからユーザー名を抽出
      const usernames = targets.map(t => t.replace(/.*\/user\//, '').trim());

      const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
        p_account_id: selectedAccount,
        p_targets: usernames,
        p_message: message,
        p_template_name: null,
      });

      if (rpcErr) throw rpcErr;

      // RPC関数がエラーを返した場合（上限超え等）
      if (data?.error) {
        setError(`${data.error} (使用済み: ${data.used}/${data.limit})`);
        return;
      }

      const originalBid = data?.batch_id;
      const count = data?.count || usernames.length;

      // 送信モード設定をキャンペーンに埋め込み（background.jsが解析）
      const modePrefix = sendMode === 'pipeline' ? `pipe${tabs}` : 'seq';
      const bid = `${modePrefix}_${originalBid}`;

      // dm_send_logのcampaignフィールドを更新
      await sb.from('dm_send_log')
        .update({ campaign: bid })
        .eq('campaign', originalBid);

      setBatchId(bid);
      setQueuedCount(count);
      setStatusCounts({ total: count, queued: count, sending: 0, success: 0, error: 0 });
      if (bid) pollStatus(bid);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  };

  // === お礼DMロジック ===
  const detectWhales = async () => {
    if (!selectedAccount) { setWhaleError('アカウントを選択してください'); return; }
    setWhaleLoading(true); setWhaleError(null); setWhales([]); setWhaleChecked(new Set()); setThankResult(null);
    try {
      const daysAgo = parseInt(thankPeriod);
      const sinceDate = new Date(Date.now() - daysAgo * 86400000);
      sinceDate.setHours(0, 0, 0, 0);

      // coin_transactions から期間内の課金ユーザーを取得
      const { data: txData } = await sb.from('coin_transactions')
        .select('user_name, tokens, created_at')
        .eq('account_id', selectedAccount)
        .gte('created_at', sinceDate.toISOString());

      // ユーザー別集計
      const userMap: Record<string, { total: number; first: string }> = {};
      (txData || []).forEach(tx => {
        if (!userMap[tx.user_name]) userMap[tx.user_name] = { total: 0, first: tx.created_at };
        userMap[tx.user_name].total += (tx.tokens || 0);
      });

      // 最低コイン数以上をフィルタ
      const filtered = Object.entries(userMap)
        .filter(([, v]) => v.total >= thankMinCoins)
        .map(([user_name, v]) => ({
          user_name,
          total_tokens: v.total,
          first_paid: v.first || sinceDate.toISOString(),
          already_dm_sent: false,
        }));

      // DM送信済みチェック
      if (filtered.length > 0) {
        const { data: dmData } = await sb.from('dm_send_log')
          .select('user_name')
          .eq('account_id', selectedAccount)
          .in('user_name', filtered.map(f => f.user_name))
          .eq('status', 'success');
        const sentSet = new Set((dmData || []).map(d => d.user_name));
        filtered.forEach(f => { f.already_dm_sent = sentSet.has(f.user_name); });
      }

      setWhales(filtered);
      const autoChecked = new Set<string>();
      filtered.forEach(w => { if (!w.already_dm_sent) autoChecked.add(w.user_name); });
      setWhaleChecked(autoChecked);
    } catch (e: unknown) {
      setWhaleError(e instanceof Error ? e.message : 'エラーが発生しました');
    }
    setWhaleLoading(false);
  };

  const toggleWhale = (un: string) => {
    setWhaleChecked(prev => {
      const next = new Set(prev);
      if (next.has(un)) next.delete(un); else next.add(un);
      return next;
    });
  };

  const selectAll = () => setWhaleChecked(new Set(whales.map(w => w.user_name)));
  const deselectAll = () => setWhaleChecked(new Set());

  const handleThankSend = async () => {
    if (whaleChecked.size === 0) { setWhaleError('ユーザーを1名以上選択してください'); return; }
    if (!thankMessage.trim()) { setWhaleError('メッセージを入力してください'); return; }
    if (!selectedAccount) { setWhaleError('アカウントを選択してください'); return; }
    setThankSending(true); setWhaleError(null); setThankResult(null);
    try {
      // お礼DMはユーザーごとにメッセージを個別化するため、個別INSERTを使う
      // ただしRPC経由でプラン上限チェックを行う
      const usernames = Array.from(whaleChecked);
      // まず上限チェック用に1件目のメッセージでRPCを呼ぶ
      const { data, error: rpcErr } = await sb.rpc('create_dm_batch_personalized', {
        p_account_id: selectedAccount,
        p_usernames: usernames,
        p_message_template: thankMessage,
        p_template_name: 'thank_dm',
      });

      if (rpcErr) {
        // RPC関数が存在しない場合はフォールバック（直接INSERT）
        if (rpcErr.message?.includes('function') || rpcErr.code === '42883') {
          console.warn('[DM] create_dm_batch_personalized未実装 → 直接INSERT');
          const bid = `thank_${Date.now()}`;
          const rows = usernames.map(un => ({
            account_id: selectedAccount,
            user_name: un,
            profile_url: `https://stripchat.com/user/${un}`,
            message: thankMessage.replace('{username}', un),
            status: 'queued',
            campaign: bid,
            template_name: 'thank_dm',
            queued_at: new Date().toISOString(),
          }));
          const { error: insertErr } = await sb.from('dm_send_log').insert(rows);
          if (insertErr) throw insertErr;
          setThankResult({ queued: rows.length, batch_id: bid });
        } else {
          throw rpcErr;
        }
      } else if (data?.error) {
        setWhaleError(`${data.error} (使用済み: ${data.used}/${data.limit})`);
        return;
      } else {
        setThankResult({ queued: data?.count || usernames.length, batch_id: data?.batch_id || '' });
      }
    } catch (e: unknown) {
      setWhaleError(e instanceof Error ? e.message : 'エラーが発生しました');
    }
    setThankSending(false);
  };

  if (!user) return null;

  return (
    <div className="max-w-[1400px] space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">DM</h1>
          <span className="badge-info text-[10px]">V7.0</span>
          <span className="badge-info text-[10px] flex items-center gap-1">
            Chrome拡張で実行
          </span>
        </div>
        {accounts.length > 0 && (
          <select className="input-glass text-xs px-3 py-2 w-48"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
          </select>
        )}
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1">
        {([
          { key: 'bulk' as const, label: '一斉送信' },
          { key: 'thank' as const, label: 'お礼DM' },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ============ 一斉送信タブ ============ */}
      {tab === 'bulk' && (
        <div className="space-y-4 anim-fade-up">
          <div className="grid grid-cols-12 gap-4">
            {/* Left: Targets */}
            <div className="col-span-3 glass-card p-5">
              <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                Target
              </h3>
              <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>URLまたはユーザー名（1行1件、{targets.length}件）</p>
              <textarea
                className="input-glass font-mono text-[11px] leading-relaxed h-48 resize-none"
                value={targetsText}
                onChange={e => setTargetsText(e.target.value)}
                placeholder="https://ja.stripchat.com/user/username&#10;またはユーザー名を1行ずつ"
              />
              <div className="mt-4">
                <div className="flex items-center justify-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>確定ターゲット</span>
                  <span className="text-2xl font-bold">{targets.length}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>名</span>
                </div>
              </div>
            </div>

            {/* Center: Message + Image */}
            <div className="col-span-5 space-y-4">
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-3 flex items-center gap-2">Message</h3>
                <textarea className="input-glass h-28 resize-none text-sm"
                  value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder="メッセージを入力..." />
              </div>
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-3 flex items-center gap-2">Image</h3>
                <div className="border-2 border-dashed rounded-xl p-8 text-center transition-colors hover:border-sky-500/30"
                  style={{ borderColor: 'var(--border-glass)' }}>
                  <div className="text-4xl mb-3 opacity-30">+</div>
                  <p className="text-sm mb-1">ファイルをドラッグ&ドロップ</p>
                  <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>PNG, JPG, GIF (MAX 200MB)</p>
                  <button className="btn-ghost text-xs">ファイルを閲覧する</button>
                </div>
              </div>
            </div>

            {/* Right: Settings */}
            <div className="col-span-4 glass-card p-5">
              <h3 className="text-sm font-bold mb-4 flex items-center gap-2">Settings</h3>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>順番送信</p>
                <div className="space-y-2">
                  {([
                    { key: 'text-image' as const, label: 'テキスト → 画像' },
                    { key: 'image-text' as const, label: '画像 → テキスト' },
                    { key: 'text-only' as const, label: 'テキストのみ' },
                  ]).map(o => (
                    <button key={o.key} onClick={() => setSendOrder(o.key)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                        sendOrder === o.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'
                      }`}>
                      <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendOrder === o.key ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>アクセス画像</p>
                <div className="flex gap-2">
                  <button onClick={() => setAccessImage('free')}
                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${accessImage === 'free' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'btn-ghost'}`}>無料</button>
                  <button onClick={() => setAccessImage('paid')}
                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${accessImage === 'paid' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'btn-ghost'}`}>有料設定</button>
                </div>
              </div>
              <div className="mb-5">
                <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>送信モード</p>
                <div className="space-y-2">
                  <button onClick={() => setSendMode('sequential')}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${sendMode === 'sequential' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'sequential' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                    順次 (安全)
                  </button>
                  <button onClick={() => setSendMode('pipeline')}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${sendMode === 'pipeline' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'}`}>
                    <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'pipeline' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                    パイプライン (高速)
                  </button>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>同時タブ</p>
                  <span className="text-2xl font-bold text-sky-400">{tabs}</span>
                </div>
                <input type="range" min="1" max="5" value={tabs}
                  onChange={(e) => setTabs(Number(e.target.value))} className="w-full accent-sky-400" />
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.2)', color: 'var(--accent-pink)' }}>
              {error}
            </div>
          )}

          {/* Send Button */}
          <button onClick={handleSend} disabled={sending}
            className="w-full py-4 rounded-2xl text-lg font-bold text-white transition-all duration-300 flex items-center justify-center gap-3 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)', boxShadow: '0 6px 30px rgba(244,63,94,0.3)' }}>
            {sending ? 'キュー登録中...' : `送信開始（${targets.length}件）`}
          </button>

          {/* Batch Status */}
          {batchId && (
            <div className="glass-card p-5 anim-fade-up">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold">送信ステータス</h3>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{batchId}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-800 mb-4 overflow-hidden">
                {statusCounts.total > 0 && (
                  <div className="h-full rounded-full transition-all duration-500 flex">
                    <div className="h-full bg-emerald-500" style={{ width: `${(statusCounts.success / statusCounts.total) * 100}%` }} />
                    <div className="h-full bg-sky-500" style={{ width: `${(statusCounts.sending / statusCounts.total) * 100}%` }} />
                    <div className="h-full bg-rose-500" style={{ width: `${(statusCounts.error / statusCounts.total) * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>待機</p>
                  <p className="text-lg font-bold">{statusCounts.queued}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-primary)' }}>送信中</p>
                  <p className="text-lg font-bold text-sky-400">{statusCounts.sending}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-green)' }}>成功</p>
                  <p className="text-lg font-bold text-emerald-400">{statusCounts.success}</p>
                </div>
                <div className="glass-panel p-3 rounded-xl text-center">
                  <p className="text-[10px] mb-1" style={{ color: 'var(--accent-pink)' }}>失敗</p>
                  <p className="text-lg font-bold text-rose-400">{statusCounts.error}</p>
                </div>
              </div>
              {recentLogs.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-auto">
                  {recentLogs.map(log => (
                    <div key={log.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
                      style={{ background: 'rgba(15,23,42,0.3)' }}>
                      <span className={
                        log.status === 'success' ? 'text-emerald-400' :
                        log.status === 'error' ? 'text-rose-400' :
                        log.status === 'sending' ? 'text-sky-400' : 'text-slate-500'
                      }>
                        {log.status === 'success' ? '\u2713' : log.status === 'error' ? '\u2715' : log.status === 'sending' ? '\u21BB' : '\u25CB'}
                      </span>
                      <span className="font-medium flex-1 truncate">{log.user_name}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{log.status}</span>
                      {log.error && <span className="text-rose-400 truncate max-w-[200px]">{log.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============ お礼DMタブ ============ */}
      {tab === 'thank' && (
        <div className="space-y-4 anim-fade-up">
          {/* Controls */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-4">新規太客を検出</h3>
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>期間</label>
                <select className="input-glass text-xs px-3 py-2 w-32"
                  value={thankPeriod} onChange={e => setThankPeriod(e.target.value as '1' | '3' | '7')}>
                  <option value="1">昨日</option>
                  <option value="3">直近3日</option>
                  <option value="7">直近7日</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>最低コイン数</label>
                <input type="number" className="input-glass text-xs px-3 py-2 w-28"
                  value={thankMinCoins} onChange={e => setThankMinCoins(Number(e.target.value))} min={1} />
              </div>
              <button onClick={detectWhales} disabled={whaleLoading}
                className="btn-primary text-xs px-5 py-2.5 disabled:opacity-50">
                {whaleLoading ? '検出中...' : '検出する'}
              </button>
            </div>
          </div>

          {/* Error */}
          {whaleError && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(244,63,94,0.08)', borderColor: 'rgba(244,63,94,0.2)', color: 'var(--accent-pink)' }}>
              {whaleError}
            </div>
          )}

          {/* Success Toast */}
          {thankResult && (
            <div className="px-4 py-3 rounded-xl text-sm border"
              style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.2)', color: '#22c55e' }}>
              {thankResult.queued}件のお礼DMをキューに追加しました（{thankResult.batch_id}）
            </div>
          )}

          {/* Whale Results */}
          {whales.length > 0 && (
            <>
              {/* Whale Table */}
              <div className="glass-card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold">
                    検出結果（{whales.length}名）
                  </h3>
                  <div className="flex gap-2">
                    <button onClick={selectAll} className="btn-ghost text-[10px] px-3 py-1">全選択</button>
                    <button onClick={deselectAll} className="btn-ghost text-[10px] px-3 py-1">全解除</button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                        <th className="pb-3 font-medium text-xs w-10"></th>
                        <th className="pb-3 font-medium text-xs">ユーザー名</th>
                        <th className="pb-3 font-medium text-xs text-right">課金額</th>
                        <th className="pb-3 font-medium text-xs text-right">初課金日</th>
                        <th className="pb-3 font-medium text-xs text-center">DM状況</th>
                      </tr>
                    </thead>
                    <tbody>
                      {whales.map(w => (
                        <tr key={w.user_name} className="border-t cursor-pointer hover:bg-white/[0.02] transition-colors"
                          style={{ borderColor: 'var(--border-glass)' }}
                          onClick={() => toggleWhale(w.user_name)}>
                          <td className="py-3">
                            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                              whaleChecked.has(w.user_name)
                                ? 'bg-sky-500 border-sky-500' : 'border-slate-600'
                            }`}>
                              {whaleChecked.has(w.user_name) && (
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                  <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </div>
                          </td>
                          <td className="py-3 font-medium">{w.user_name}</td>
                          <td className="py-3 text-right">
                            <span className="text-emerald-400 font-semibold">{w.total_tokens.toLocaleString()} tk</span>
                            <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
                              ({tokensToJPY(w.total_tokens)})
                            </span>
                          </td>
                          <td className="py-3 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {w.first_paid.slice(0, 10)}
                          </td>
                          <td className="py-3 text-center">
                            {w.already_dm_sent ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">送信済み</span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-400">未送信</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {whaleChecked.size}名 選択中
                </div>
              </div>

              {/* Message + Send */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-3">お礼メッセージ</h3>
                <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  {'{username}'} はユーザー名に自動置換されます
                </p>
                <textarea
                  className="input-glass h-24 resize-none text-sm"
                  value={thankMessage}
                  onChange={e => setThankMessage(e.target.value)}
                  placeholder="お礼メッセージを入力..."
                />

                <button onClick={handleThankSend} disabled={thankSending || whaleChecked.size === 0}
                  className="w-full mt-4 py-3 rounded-xl text-sm font-bold text-white transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{
                    background: whaleChecked.size > 0
                      ? 'linear-gradient(135deg, #22c55e, #16a34a)'
                      : 'linear-gradient(135deg, #475569, #334155)',
                    boxShadow: whaleChecked.size > 0 ? '0 6px 30px rgba(34,197,94,0.3)' : 'none',
                  }}>
                  {thankSending
                    ? 'キュー登録中...'
                    : `お礼DMを送信（${whaleChecked.size}件）`
                  }
                </button>
              </div>
            </>
          )}

          {/* Empty state */}
          {!whaleLoading && whales.length === 0 && !whaleError && (
            <div className="glass-card p-10 text-center">
              <p className="text-4xl mb-4 opacity-30">+</p>
              <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
                「検出する」をクリックして新規太客を検索
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                期間中に初めて課金し、閾値以上のコインを使ったユーザーが表示されます。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
