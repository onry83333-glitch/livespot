'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { isDmTestMode, DM_TEST_WHITELIST, getDmGuardStatus } from '@/lib/dm-guard';
import { formatTokens } from '@/lib/utils';
import type { DMLogItem, DmScheduleItem, FanItem, SB } from '@/types/dm';

interface DmSendPanelProps {
  accountId: string;
  castName: string;
  sb: SB;
  fans: FanItem[];
  dmLogs: DMLogItem[];
  setDmLogs: (logs: DMLogItem[]) => void;
  dmSchedules: DmScheduleItem[];
  setDmSchedules: React.Dispatch<React.SetStateAction<DmScheduleItem[]>>;
}

export default function DmSendPanel({
  accountId, castName, sb, fans, dmLogs, setDmLogs,
  dmSchedules, setDmSchedules,
}: DmSendPanelProps) {
  // Send form state
  const [dmTargets, setDmTargets] = useState<Set<string>>(new Set());
  const [dmTargetsText, setDmTargetsText] = useState('');
  const [dmMessage, setDmMessage] = useState('');
  const [dmCampaign, setDmCampaign] = useState('');
  const [dmIsTest, setDmIsTest] = useState(process.env.NODE_ENV === 'development');
  const [dmSendMode, setDmSendMode] = useState<'sequential' | 'pipeline'>('pipeline');
  const [dmTabs, setDmTabs] = useState(3);
  const [dmSending, setDmSending] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  const [dmResult, setDmResult] = useState<{ count: number; batch_id: string } | null>(null);
  const [dmStatusCounts, setDmStatusCounts] = useState({ total: 0, queued: 0, sending: 0, success: 0, error: 0 });
  const [dmBatchId, setDmBatchId] = useState<string | null>(null);

  // Schedule state
  const [dmScheduleMode, setDmScheduleMode] = useState(false);
  const [dmScheduleDate, setDmScheduleDate] = useState('');
  const [dmScheduleTime, setDmScheduleTime] = useState('');
  const [dmScheduleSaving, setDmScheduleSaving] = useState(false);

  // Image state
  const [dmImageFile, setDmImageFile] = useState<File | null>(null);
  const [dmImagePreview, setDmImagePreview] = useState<string | null>(null);
  const dmImageInputRef = useRef<HTMLInputElement>(null);

  // Delivery mode
  const [dmDeliveryMode, setDmDeliveryMode] = useState<'fast_text' | 'image_pipeline'>('fast_text');
  const [dmSendOrder, setDmSendOrder] = useState<'text_only' | 'image_only' | 'text_then_image' | 'image_then_text'>('text_only');

  // Safety gates
  const [dmShowPreview, setDmShowPreview] = useState(false);
  const [dmPreviewConfirmed, setDmPreviewConfirmed] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [sendUnlocked, setSendUnlocked] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime status polling
  const dmBatchIdRef = useRef(dmBatchId);
  dmBatchIdRef.current = dmBatchId;
  const dmCastChannelRef = useRef<ReturnType<typeof sb.channel> | null>(null);

  useEffect(() => {
    // 前のチャネルをクリーンアップ
    if (dmCastChannelRef.current) {
      sb.removeChannel(dmCastChannelRef.current);
      dmCastChannelRef.current = null;
    }

    const channel = sb
      .channel(`dm-cast-status-realtime-${castName}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_send_log', filter: `cast_name=eq.${castName},account_id=eq.${accountId}` }, async () => {
        const bid = dmBatchIdRef.current;
        if (!bid) return;
        const { data: items } = await sb.from('dm_send_log')
          .select('*').eq('campaign', bid).eq('cast_name', castName).order('created_at', { ascending: false }).limit(5000);
        const logs = items || [];
        const counts = { total: logs.length, queued: 0, sending: 0, success: 0, error: 0 };
        logs.forEach((l: { status: string }) => { if (l.status in counts) (counts as Record<string, number>)[l.status]++; });
        setDmStatusCounts(counts);
      });

    // Subscribe using the imported helper
    import('@/lib/realtime-helpers').then(({ subscribeWithRetry }) => subscribeWithRetry(channel));

    dmCastChannelRef.current = channel;

    return () => {
      if (dmCastChannelRef.current) {
        sb.removeChannel(dmCastChannelRef.current);
        dmCastChannelRef.current = null;
      }
    };
  }, [accountId, castName, sb]);

  // Cleanup unlock timer
  useEffect(() => {
    return () => { if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current); };
  }, []);

  // Target management
  const toggleTarget = useCallback((un: string) => {
    setDmTargets(prev => { const n = new Set(prev); if (n.has(un)) n.delete(un); else n.add(un); return n; });
  }, []);

  const addFansAsTargets = useCallback((filter: 'all' | 'vip' | 'regular') => {
    const filtered = filter === 'vip' ? fans.filter(f => f.total_tokens >= 100)
      : filter === 'regular' ? fans.filter(f => f.msg_count >= 3)
      : fans;
    setDmTargets(new Set(filtered.map(f => f.user_name)));
  }, [fans]);

  const handleAddTextTargets = useCallback(() => {
    const lines = dmTargetsText.split('\n').map(l => l.trim()).filter(Boolean);
    const usernames = lines.map(l => l.replace(/.*\/user\//, '').replace(/\/$/, '').trim()).filter(Boolean);
    if (usernames.length === 0) return;
    setDmTargets(prev => {
      const next = new Set(prev);
      usernames.forEach(un => next.add(un));
      return next;
    });
    setDmTargetsText('');
  }, [dmTargetsText]);

  const removeTarget = useCallback((un: string) => {
    setDmTargets(prev => { const next = new Set(prev); next.delete(un); return next; });
  }, []);

  // DM Send
  const handleDmSend = useCallback(async () => {
    console.log('[DM-Cast] handleDmSend called, targets:', dmTargets.size, 'cast:', castName, 'deliveryMode:', dmDeliveryMode, 'sendOrder:', dmSendOrder);
    const needsMessage = dmSendOrder !== 'image_only';
    const needsImage = dmDeliveryMode === 'image_pipeline' && (dmSendOrder === 'image_only' || dmSendOrder === 'text_then_image' || dmSendOrder === 'image_then_text');
    if (dmTargets.size === 0 || (needsMessage && !dmMessage.trim()) || (needsImage && !dmImageFile) || !accountId) return;

    if (!dmCampaign.trim()) {
      setDmError('キャンペーンタグは必須です。送信目的を識別するタグを入力してください。');
      return;
    }

    const guardStatus = getDmGuardStatus();
    if (guardStatus.isTestMode) {
      const blocked = Array.from(dmTargets).filter(u => !DM_TEST_WHITELIST.has(u));
      if (blocked.length > 0) {
        const sample = blocked.slice(0, 5).join(', ');
        const suffix = blocked.length > 5 ? ` 他${blocked.length - 5}名` : '';
        setDmError(`[テストモード] ホワイトリスト外のユーザー${blocked.length}名をブロック: ${sample}${suffix}\n許可: ${guardStatus.whitelist.join(', ')}\n本番送信するにはDM_TEST_MODE=falseを設定`);
        return;
      }
    }

    if (!dmPreviewConfirmed) {
      setDmShowPreview(true);
      return;
    }

    setDmSending(true); setDmError(null); setDmResult(null);
    try {
      const usernames = Array.from(dmTargets);
      const modePrefix = dmSendMode === 'pipeline' ? `pipe${dmTabs}` : 'seq';
      const tag = dmCampaign.trim() ? `${dmCampaign.trim()}_` : '';
      const now = new Date();
      const timestamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;

      let originalBid: string | null = null;
      let count = usernames.length;
      let usedRpc = false;

      console.log('[DM-Cast] Step1: calling create_dm_batch RPC...');
      try {
        const { data, error: rpcErr } = await sb.rpc('create_dm_batch', {
          p_account_id: accountId,
          p_cast_name: castName,
          p_targets: usernames,
          p_message: dmMessage,
          p_template_name: null,
        });
        console.log('[DM-Cast] Step1 RPC result:', JSON.stringify({ data, error: rpcErr }));

        if (!rpcErr && data && !data.error) {
          originalBid = data.batch_id;
          count = data.count || usernames.length;
          usedRpc = true;
        } else if (data?.error && !data?.batch_id) {
          setDmError(`⚠ ${data.error} (使用済み: ${data.used}/${data.limit})`);
          setDmSending(false);
          return;
        } else {
          console.warn('[DM-Cast] Step1 RPC failed, fallback to INSERT:', rpcErr?.message);
        }
      } catch (rpcException) {
        console.warn('[DM-Cast] Step1 RPC exception, fallback to INSERT:', rpcException);
      }

      let uploadedImageUrl: string | null = null;
      if (dmImageFile) {
        const ext = dmImageFile.name.split('.').pop() || 'jpg';
        const path = `dm/${accountId}/${timestamp}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: uploadErr } = await sb.storage.from('dm-images').upload(path, dmImageFile, {
          contentType: dmImageFile.type,
          upsert: false,
        });
        if (uploadErr) {
          console.error('[DM-Cast] 画像アップロード失敗:', uploadErr.message);
          setDmError(`画像アップロード失敗: ${uploadErr.message}`);
          setDmSending(false);
          return;
        }
        const { data: urlData } = sb.storage.from('dm-images').getPublicUrl(path);
        uploadedImageUrl = urlData.publicUrl;
        console.log('[DM-Cast] 画像アップロード完了:', uploadedImageUrl);
      }

      if (!usedRpc || uploadedImageUrl) {
        if (usedRpc && uploadedImageUrl) {
          const effectiveSendOrder = dmDeliveryMode === 'fast_text' ? 'text_only' : dmSendOrder;
          await sb.from('dm_send_log')
            .update({ image_url: uploadedImageUrl, image_sent: true, send_order: effectiveSendOrder })
            .eq('campaign', originalBid);
          console.log('[DM-Cast] RPC登録分にimage_url付与:', originalBid);
        } else if (!usedRpc) {
          console.log('[DM-Cast] Step2: direct INSERT for', usernames.length, 'users');
          originalBid = `bulk_${timestamp}`;
          const effectiveSendOrder = dmDeliveryMode === 'fast_text' ? 'text_only' : dmSendOrder;
          const rows = usernames.map(un => ({
            account_id: accountId,
            user_name: un,
            message: effectiveSendOrder === 'image_only' ? '' : dmMessage,
            image_url: uploadedImageUrl,
            image_sent: !!uploadedImageUrl,
            send_order: effectiveSendOrder,
            status: 'queued',
            campaign: originalBid,
            cast_name: castName,
            queued_at: now.toISOString(),
          }));
          const { error: insertErr } = await sb.from('dm_send_log').insert(rows);
          if (insertErr) {
            console.error('[DM-Cast] Step2 INSERT failed:', insertErr.message);
            setDmError(`キュー登録失敗: ${insertErr.message}`);
            setDmSending(false);
            return;
          }
          console.log('[DM-Cast] Step2 INSERT success:', rows.length, 'rows');
        }
      }

      const testPrefix = dmIsTest ? 'test_' : '';
      const bid = `${testPrefix}${modePrefix}_${tag}${originalBid}`;
      console.log('[DM-Cast] Step3: campaign=', bid, dmIsTest ? '(test mode)' : '');
      await sb.from('dm_send_log').update({ campaign: bid, cast_name: castName }).eq('campaign', originalBid);

      setDmBatchId(bid);
      setDmResult({ count, batch_id: bid });
      setDmStatusCounts({ total: count, queued: count, sending: 0, success: 0, error: 0 });
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');
      setDmImageFile(null);
      setDmPreviewConfirmed(false);
      setDmShowPreview(false);
      if (dmImagePreview) { URL.revokeObjectURL(dmImagePreview); setDmImagePreview(null); }

      const { data: logs } = await sb.from('dm_send_log')
        .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
        .eq('account_id', accountId).eq('cast_name', castName).order('created_at', { ascending: false }).limit(200);
      setDmLogs((logs || []) as DMLogItem[]);

      console.log('[DM-Cast] handleDmSend complete: bid=', bid, 'count=', count, 'rpc=', usedRpc);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[DM-Cast] handleDmSend error:', errMsg, e);
      setDmError(errMsg);
    }
    setDmSending(false);
  }, [dmTargets, dmMessage, dmCampaign, dmIsTest, dmSendMode, dmTabs, accountId, castName, sb, dmImageFile, dmImagePreview, dmDeliveryMode, dmSendOrder, dmPreviewConfirmed, setDmLogs]);

  const handleUnlockToggle = useCallback(() => {
    if (sendUnlocked) {
      setSendUnlocked(false);
      if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
    } else {
      setSendUnlocked(true);
      unlockTimerRef.current = setTimeout(() => {
        setSendUnlocked(false);
        unlockTimerRef.current = null;
      }, 10000);
    }
  }, [sendUnlocked]);

  const handleConfirmedSend = useCallback(() => {
    if (!sendUnlocked) return;
    setSendUnlocked(false);
    if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
    setShowConfirmModal(false);
    handleDmSend();
  }, [sendUnlocked, handleDmSend]);

  const handleScheduleDm = useCallback(async () => {
    if (dmTargets.size === 0 || !dmMessage.trim() || !accountId || !dmScheduleDate || !dmScheduleTime) return;
    setDmScheduleSaving(true);
    setDmError(null);

    try {
      const scheduledAt = new Date(`${dmScheduleDate}T${dmScheduleTime}:00`).toISOString();
      const usernames = Array.from(dmTargets);
      const rawTag = dmCampaign.trim() || null;
      const campaignTag = dmIsTest ? `test_${rawTag || 'scheduled'}` : rawTag;

      const { data, error } = await sb.from('dm_schedules').insert({
        account_id: accountId,
        cast_name: castName,
        message: dmMessage,
        target_segment: null,
        target_usernames: usernames,
        scheduled_at: scheduledAt,
        total_count: usernames.length,
        campaign: campaignTag,
        send_mode: dmSendMode,
        tab_count: dmTabs,
      }).select().single();

      if (error) throw error;

      setDmSchedules(prev => [data as DmScheduleItem, ...prev]);
      setDmTargets(new Set());
      setDmMessage('');
      setDmCampaign('');
      setDmScheduleDate('');
      setDmScheduleTime('');
      setDmScheduleMode(false);
    } catch (e: unknown) {
      setDmError(e instanceof Error ? e.message : String(e));
    }
    setDmScheduleSaving(false);
  }, [dmTargets, dmMessage, dmCampaign, dmIsTest, dmSendMode, dmTabs, dmScheduleDate, dmScheduleTime, accountId, castName, sb, setDmSchedules]);

  const handleCancelSchedule = useCallback(async (scheduleId: string) => {
    const { error } = await sb
      .from('dm_schedules')
      .update({ status: 'cancelled' })
      .eq('id', scheduleId)
      .eq('status', 'pending');

    if (error) return;
    setDmSchedules(prev => prev.map(s => s.id === scheduleId ? { ...s, status: 'cancelled' } : s));
  }, [sb, setDmSchedules]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          {/* Send form */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-4">✉️ DM送信</h3>

            {/* 送信モード選択カード */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <button
                onClick={() => {
                  setDmDeliveryMode('fast_text');
                  setDmSendMode('sequential');
                  setDmSendOrder('text_only');
                  setDmImageFile(null);
                  if (dmImagePreview) { URL.revokeObjectURL(dmImagePreview); setDmImagePreview(null); }
                }}
                className="p-3 rounded-xl text-left transition-all"
                style={{
                  background: dmDeliveryMode === 'fast_text' ? 'rgba(56,189,248,0.1)' : 'rgba(15,23,42,0.4)',
                  border: `1px solid ${dmDeliveryMode === 'fast_text' ? 'rgba(56,189,248,0.3)' : 'var(--border-glass)'}`,
                }}
              >
                <p className="text-xs font-bold mb-1" style={{ color: dmDeliveryMode === 'fast_text' ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                  ⚡ 高速テキスト送信
                </p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>API送信（~2秒/通）</p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>テキストDMのみ</p>
              </button>
              <button
                onClick={() => {
                  setDmDeliveryMode('image_pipeline');
                  setDmSendMode('pipeline');
                  if (dmSendOrder === 'text_only') setDmSendOrder('text_then_image');
                }}
                className="p-3 rounded-xl text-left transition-all"
                style={{
                  background: dmDeliveryMode === 'image_pipeline' ? 'rgba(167,139,250,0.1)' : 'rgba(15,23,42,0.4)',
                  border: `1px solid ${dmDeliveryMode === 'image_pipeline' ? 'rgba(167,139,250,0.3)' : 'var(--border-glass)'}`,
                }}
              >
                <p className="text-xs font-bold mb-1" style={{ color: dmDeliveryMode === 'image_pipeline' ? 'var(--accent-purple)' : 'var(--text-secondary)' }}>
                  🖼 画像付きパイプライン
                </p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>DOM操作（~18秒/通）</p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>画像+テキスト対応</p>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>キャンペーンタグ</label>
                <div className="flex gap-2 items-center">
                  <input type="text" value={dmCampaign} onChange={e => setDmCampaign(e.target.value)}
                    className="input-glass text-xs flex-1" placeholder="例: バレンタイン復帰DM" />
                  <button
                    onClick={() => setDmIsTest(p => !p)}
                    className={`shrink-0 text-[10px] px-2.5 py-1.5 rounded-lg font-medium transition-all ${dmIsTest ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40' : 'btn-ghost opacity-60'}`}
                    title="ONにするとcampaignにtest_プレフィックスが付き、テストデータ管理から一括削除可能"
                  >
                    {dmIsTest ? 'テスト ON' : 'テスト'}
                  </button>
                </div>
                {dmIsTest && (
                  <p className="text-[9px] mt-1" style={{ color: 'var(--accent-amber)' }}>
                    test_ プレフィックスが自動付与されます（管理画面から一括削除可能）
                  </p>
                )}
              </div>
              {dmDeliveryMode === 'image_pipeline' && (
                <div>
                  <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>パイプライン設定</label>
                  <div className="flex gap-2">
                    <button onClick={() => setDmSendMode('pipeline')}
                      className={`text-[10px] px-3 py-1.5 rounded-lg ${dmSendMode === 'pipeline' ? 'btn-primary' : 'btn-ghost'}`}>
                      パイプライン ({dmTabs}tab)
                    </button>
                    <button onClick={() => setDmSendMode('sequential')}
                      className={`text-[10px] px-3 py-1.5 rounded-lg ${dmSendMode === 'sequential' ? 'btn-primary' : 'btn-ghost'}`}>
                      順次
                    </button>
                    {dmSendMode === 'pipeline' && (
                      <select value={dmTabs} onChange={e => setDmTabs(Number(e.target.value))}
                        className="input-glass text-[10px] py-1 px-2 w-16">
                        {[2, 3, 4, 5].map(n => <option key={n} value={n}>{n}tab</option>)}
                      </select>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 送信順序セレクター */}
            {dmDeliveryMode === 'image_pipeline' && (
              <div className="mb-3">
                <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>送信順序</label>
                <div className="flex gap-1.5 flex-wrap">
                  {([
                    { key: 'text_then_image' as const, label: 'テキスト→画像', desc: 'テキスト送信後に画像送信' },
                    { key: 'image_then_text' as const, label: '画像→テキスト', desc: '画像送信後にテキスト送信' },
                    { key: 'text_only' as const, label: 'テキストのみ', desc: '画像を使わずテキストのみ' },
                    { key: 'image_only' as const, label: '画像のみ', desc: 'テキストなしで画像のみ' },
                  ]).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setDmSendOrder(opt.key)}
                      className="text-[10px] px-3 py-1.5 rounded-lg transition-all"
                      style={{
                        background: dmSendOrder === opt.key ? 'rgba(167,139,250,0.12)' : 'transparent',
                        color: dmSendOrder === opt.key ? 'var(--accent-purple)' : 'var(--text-muted)',
                        border: dmSendOrder === opt.key ? '1px solid rgba(167,139,250,0.25)' : '1px solid transparent',
                      }}
                      title={opt.desc}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                メッセージ {dmSendOrder !== 'image_only' && <span style={{ color: 'var(--accent-pink)' }}>*</span>}
                {dmSendOrder === 'image_only' && <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>（任意）</span>}
              </label>
              <textarea value={dmMessage} onChange={e => setDmMessage(e.target.value)}
                className="input-glass text-xs w-full h-24 resize-none"
                placeholder={dmSendOrder === 'image_only' ? '画像のみ送信（テキストは任意）' : 'メッセージを入力... {username}でユーザー名置換'} />
            </div>

            {/* 画像添付 */}
            {dmDeliveryMode === 'image_pipeline' && (
            <div className="mb-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                画像添付{dmSendOrder === 'image_only' || dmSendOrder === 'text_then_image' || dmSendOrder === 'image_then_text'
                  ? <span style={{ color: 'var(--accent-pink)' }}> *</span>
                  : '（任意）'}
              </label>
              <input
                ref={dmImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setDmImageFile(file);
                    if (dmImagePreview) URL.revokeObjectURL(dmImagePreview);
                    setDmImagePreview(URL.createObjectURL(file));
                  }
                  e.target.value = '';
                }}
              />
              {dmImagePreview ? (
                <div className="flex items-start gap-3">
                  <div className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={dmImagePreview} alt="DM画像プレビュー" className="w-20 h-20 rounded-lg object-cover border" style={{ borderColor: 'var(--border-glass)' }} />
                    <button
                      onClick={() => {
                        setDmImageFile(null);
                        if (dmImagePreview) URL.revokeObjectURL(dmImagePreview);
                        setDmImagePreview(null);
                      }}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px]"
                      style={{ background: 'var(--accent-pink)', color: 'white' }}
                    >
                      x
                    </button>
                  </div>
                  <div className="text-[10px] pt-1" style={{ color: 'var(--text-muted)' }}>
                    <p>{dmImageFile?.name}</p>
                    <p>{dmImageFile ? `${(dmImageFile.size / 1024).toFixed(0)}KB` : ''}</p>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => dmImageInputRef.current?.click()}
                  className="btn-ghost text-[10px] px-3 py-1.5 rounded-lg"
                >
                  🖼 画像を選択
                </button>
              )}
            </div>
            )}

            {/* 送信タイミング */}
            <div className="mb-3 flex items-center gap-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>送信タイミング</label>
              <button onClick={() => setDmScheduleMode(false)}
                className={`text-[10px] px-3 py-1.5 rounded-lg ${!dmScheduleMode ? 'btn-primary' : 'btn-ghost'}`}>
                即時送信
              </button>
              <button onClick={() => setDmScheduleMode(true)}
                className={`text-[10px] px-3 py-1.5 rounded-lg ${dmScheduleMode ? 'btn-primary' : 'btn-ghost'}`}>
                🕐 スケジュール
              </button>
            </div>

            {dmScheduleMode && (
              <div className="mb-3 flex items-center gap-3">
                <input type="date" value={dmScheduleDate} onChange={e => setDmScheduleDate(e.target.value)}
                  className="input-glass text-xs py-1.5 px-3"
                  min={new Date().toISOString().split('T')[0]} />
                <input type="time" value={dmScheduleTime} onChange={e => setDmScheduleTime(e.target.value)}
                  className="input-glass text-xs py-1.5 px-3" />
                {dmScheduleDate && dmScheduleTime && (
                  <span className="text-[10px]" style={{ color: 'var(--accent-primary)' }}>
                    {new Date(`${dmScheduleDate}T${dmScheduleTime}`).toLocaleString('ja-JP')} に送信予約
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                選択中: <span className="font-bold text-white">{dmTargets.size}</span> 名
              </span>
              {dmScheduleMode ? (
                <button onClick={handleScheduleDm}
                  disabled={dmScheduleSaving || dmTargets.size === 0 || !dmMessage.trim() || !dmScheduleDate || !dmScheduleTime}
                  className="text-xs py-1.5 px-5 rounded-xl font-semibold disabled:opacity-50 transition-all"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple, #a855f7))', color: 'white' }}>
                  {dmScheduleSaving ? '予約中...' : '🕐 送信予約'}
                </button>
              ) : (
                <button onClick={async () => {
                    // セッション有効性チェック
                    const { data: sess } = await sb
                      .from('stripchat_sessions')
                      .select('expires_at, is_valid, cast_name')
                      .eq('cast_name', castName)
                      .maybeSingle();
                    if (!sess) {
                      setDmError('Chrome拡張のセッションが見つかりません。Stripchatにログインし直してください。');
                      return;
                    }
                    if (!sess.is_valid || new Date(sess.expires_at) < new Date()) {
                      setDmError('Chrome拡張のセッションが無効または期限切れです。Stripchatにログインし直してください。');
                      return;
                    }
                    setShowConfirmModal(true);
                  }}
                  disabled={dmSending || dmTargets.size === 0 || !dmMessage.trim()}
                  className="btn-primary text-xs py-1.5 px-5 disabled:opacity-50">
                  {dmSending ? '送信中...' : '送信確認'}
                </button>
              )}
            </div>

            {dmError && <p className="mt-2 text-xs" style={{ color: 'var(--accent-pink)' }}>{dmError}</p>}
            {dmResult && (
              <p className="mt-2 text-xs" style={{ color: 'var(--accent-green)' }}>
                {dmResult.count}件をキューに登録 (batch: {dmResult.batch_id})
              </p>
            )}
            {dmBatchId && dmStatusCounts.total > 0 && (
              <div className="mt-2 flex gap-3 text-[10px]">
                <span style={{ color: 'var(--text-muted)' }}>待機: {dmStatusCounts.queued}</span>
                <span style={{ color: 'var(--accent-amber)' }}>送信中: {dmStatusCounts.sending}</span>
                <span style={{ color: 'var(--accent-green)' }}>成功: {dmStatusCounts.success}</span>
                <span style={{ color: 'var(--accent-pink)' }}>エラー: {dmStatusCounts.error}</span>
              </div>
            )}
          </div>

          {/* Scheduled DMs */}
          {dmSchedules.length > 0 && (
            <div className="glass-card p-4">
              <h3 className="text-sm font-bold mb-3">📋 予約済みDM</h3>
              <div className="space-y-2 max-h-60 overflow-auto">
                {dmSchedules.map(sched => {
                  const statusIcon = sched.status === 'pending' ? '⏳' : sched.status === 'sending' ? '📤' :
                    sched.status === 'completed' ? '✅' : sched.status === 'cancelled' ? '🚫' : '❌';
                  const statusColor = sched.status === 'pending' ? 'var(--accent-amber)' : sched.status === 'sending' ? 'var(--accent-primary)' :
                    sched.status === 'completed' ? 'var(--accent-green)' : 'var(--text-muted)';
                  return (
                    <div key={sched.id} className="glass-panel px-3 py-2.5 rounded-xl">
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span>{statusIcon}</span>
                            <span className="font-semibold">{new Date(sched.scheduled_at).toLocaleString('ja-JP')}</span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              対象: {sched.target_usernames ? `${sched.target_usernames.length}名` : sched.target_segment || '--'}
                            </span>
                          </div>
                          <p className="text-[10px] mt-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                            {sched.message}
                          </p>
                          {sched.campaign && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded mt-1 inline-block"
                              style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                              {sched.campaign}
                            </span>
                          )}
                        </div>
                        <div className="flex-shrink-0 ml-2 text-right">
                          <span className="text-[10px] font-bold" style={{ color: statusColor }}>
                            {sched.status === 'completed' ? `${sched.sent_count}/${sched.total_count}` : sched.status}
                          </span>
                          {sched.status === 'pending' && (
                            <button onClick={() => handleCancelSchedule(sched.id)}
                              className="block text-[9px] mt-1 px-2 py-0.5 rounded-lg hover:bg-rose-500/10 transition-all"
                              style={{ color: 'var(--accent-pink)' }}>
                              キャンセル
                            </button>
                          )}
                          {sched.error_message && (
                            <p className="text-[9px] mt-1" style={{ color: 'var(--accent-pink)' }}>{sched.error_message}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Target selection */}
        <div className="space-y-4">
          {/* Text input for targets */}
          <div className="glass-card p-4">
            <h3 className="text-sm font-bold mb-2">テキスト入力</h3>
            <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
              URLまたはユーザー名を1行ずつ入力
            </p>
            <textarea
              value={dmTargetsText}
              onChange={e => setDmTargetsText(e.target.value)}
              className="input-glass font-mono text-[11px] leading-relaxed w-full h-28 resize-none"
              placeholder={'https://ja.stripchat.com/user/username\nまたはユーザー名を1行ずつ'}
            />
            <button onClick={handleAddTextTargets}
              disabled={!dmTargetsText.trim()}
              className="btn-primary text-[10px] py-1.5 px-4 mt-2 w-full disabled:opacity-50">
              ターゲットに追加 ({dmTargetsText.split('\n').filter(l => l.trim()).length}件)
            </button>
          </div>

          {/* Confirmed targets */}
          {dmTargets.size > 0 && (
            <div className="glass-card p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold">確定ターゲット ({dmTargets.size}名)</h3>
                <button onClick={() => setDmTargets(new Set())}
                  className="text-[9px] px-2 py-1 rounded-lg hover:bg-rose-500/10 transition-all"
                  style={{ color: 'var(--accent-pink)' }}>全クリア</button>
              </div>
              <div className="space-y-0.5 max-h-40 overflow-auto">
                {Array.from(dmTargets).map(un => (
                  <div key={un} className="flex items-center justify-between px-2 py-1.5 rounded-lg text-[11px] hover:bg-white/[0.03]">
                    <span className="font-medium truncate">{un}</span>
                    <button onClick={() => removeTarget(un)}
                      className="text-slate-500 hover:text-rose-400 transition-colors text-xs flex-shrink-0 ml-2"
                      title="削除">x</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Fan list selection — 非表示 */}
          {/* <div className="glass-card p-4">
            <h3 className="text-sm font-bold mb-2">ファン選択</h3>
            <div className="flex gap-1.5 mb-3 flex-wrap">
              <button onClick={() => addFansAsTargets('all')} className="btn-ghost text-[9px] py-1 px-2">全ファン</button>
              <button onClick={() => addFansAsTargets('vip')} className="btn-ghost text-[9px] py-1 px-2">VIP (100tk+)</button>
              <button onClick={() => addFansAsTargets('regular')} className="btn-ghost text-[9px] py-1 px-2">常連 (3回+)</button>
            </div>
            {fans.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>ファンデータなし</p>
            ) : (
              <div className="space-y-1 max-h-60 overflow-auto">
                {fans.map(f => {
                  const checked = dmTargets.has(f.user_name);
                  return (
                    <button key={f.user_name} onClick={() => toggleTarget(f.user_name)}
                      className={`w-full text-left p-2 rounded-lg text-[11px] transition-all ${checked ? 'border' : 'hover:bg-white/[0.03]'}`}
                      style={checked ? { background: 'rgba(56,189,248,0.08)', borderColor: 'rgba(56,189,248,0.2)' } : {}}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-sm border ${checked ? 'bg-sky-500 border-sky-500' : 'border-slate-600'}`} />
                          <span className="font-medium">{f.user_name}</span>
                        </div>
                        <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>{formatTokens(f.total_tokens)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div> */}
        </div>
      </div>

      {/* DM Safety: 3段階確認モーダル */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
          <div className="glass-card p-6 w-full max-w-md mx-4 anim-fade-up">
            <h3 className="text-base font-bold mb-4 flex items-center gap-2">
              <span style={{ color: 'var(--accent-pink)' }}>⚠</span>
              DM送信確認
            </h3>

            <div className="space-y-3 mb-4">
              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>送信先</p>
                <p className="text-lg font-bold">{dmTargets.size}名</p>
              </div>

              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>メッセージ</p>
                {(() => {
                  const firstUser = Array.from(dmTargets)[0] || 'ユーザー名';
                  const preview = dmMessage.replace(/\{username\}/g, firstUser);
                  return (
                    <>
                      <p className="text-xs whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                        {preview.length > 200 ? preview.slice(0, 200) + '...' : preview}
                      </p>
                      {dmMessage.includes('{username}') && (
                        <p className="text-[9px] mt-1" style={{ color: 'var(--accent-amber)' }}>
                          ※ {'{username}'} は送信時に各ユーザー名に自動置換されます
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>

              {dmCampaign && (
                <div className="glass-panel p-3 rounded-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>キャンペーン</p>
                  <p className="text-xs">
                    {dmIsTest && <span style={{ color: 'var(--accent-amber)' }}>test_ </span>}
                    {dmCampaign || '(自動生成)'}
                  </p>
                  {dmIsTest && (
                    <p className="text-[9px] mt-1" style={{ color: 'var(--accent-amber)' }}>テスト送信 — 管理画面から一括削除可能</p>
                  )}
                </div>
              )}

              {/* 送信モード情報 */}
              <div className="glass-panel p-3 rounded-xl">
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>送信モード</p>
                <p className="text-xs font-semibold" style={{ color: dmDeliveryMode === 'fast_text' ? 'var(--accent-primary)' : 'var(--accent-purple)' }}>
                  {dmDeliveryMode === 'fast_text' ? '⚡ 高速テキスト' : `🖼 画像付きパイプライン (${dmTabs}tab)`}
                </p>
                {dmDeliveryMode === 'image_pipeline' && (
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    送信順序: {dmSendOrder === 'text_then_image' ? 'テキスト→画像' : dmSendOrder === 'image_then_text' ? '画像→テキスト' : dmSendOrder === 'image_only' ? '画像のみ' : 'テキストのみ'}
                  </p>
                )}
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  推定所要時間: ~{dmDeliveryMode === 'fast_text'
                    ? `${Math.ceil(dmTargets.size * 2 / 60)}分`
                    : `${Math.ceil(dmTargets.size * 18 / (dmSendMode === 'pipeline' ? dmTabs : 1) / 60)}分`
                  }
                </p>
              </div>

              {dmImagePreview && (
                <div className="glass-panel p-3 rounded-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>添付画像</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={dmImagePreview} alt="DM添付画像" className="w-16 h-16 rounded-lg object-cover" />
                </div>
              )}

              <div className="p-3 rounded-xl" style={{ background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)' }}>
                <p className="text-[11px] font-semibold" style={{ color: 'var(--accent-pink)' }}>
                  DM送信は取り消せません。ターゲットとメッセージを必ず確認してください。
                </p>
              </div>
            </div>

            {/* 送信ロックトグル */}
            <div className="flex items-center justify-between mb-4 p-3 rounded-xl"
              style={{
                background: sendUnlocked ? 'rgba(244,63,94,0.1)' : 'rgba(15,23,42,0.4)',
                border: `1px solid ${sendUnlocked ? 'rgba(244,63,94,0.3)' : 'var(--border-glass)'}`,
              }}>
              <div>
                <p className="text-[11px] font-semibold">{sendUnlocked ? '送信ロック解除済み' : '送信ロック中'}</p>
                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {sendUnlocked ? '10秒後に自動ロックされます' : 'トグルで解除してください'}
                </p>
              </div>
              <button onClick={handleUnlockToggle}
                className="w-12 h-6 rounded-full relative transition-all duration-300"
                style={{ background: sendUnlocked ? 'var(--accent-pink)' : 'rgba(100,116,139,0.3)' }}>
                <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all duration-300"
                  style={{ left: sendUnlocked ? '26px' : '2px' }} />
              </button>
            </div>

            {/* アクションボタン */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setSendUnlocked(false);
                  if (unlockTimerRef.current) { clearTimeout(unlockTimerRef.current); unlockTimerRef.current = null; }
                }}
                className="btn-ghost text-xs py-2 px-4 flex-1">
                キャンセル
              </button>
              <button onClick={handleConfirmedSend}
                disabled={!sendUnlocked || dmSending}
                className="text-xs py-2 px-4 flex-1 rounded-xl font-semibold transition-all disabled:opacity-30"
                style={{
                  background: sendUnlocked ? 'linear-gradient(135deg, var(--accent-pink), #dc2626)' : 'rgba(100,116,139,0.2)',
                  color: 'white',
                }}>
                {dmSending ? '送信中...' : '送信実行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DM安全ゲート: 送信先プレビューモーダル */}
      {dmShowPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="glass-card p-6 rounded-2xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col" style={{ border: '1px solid rgba(56,189,248,0.2)' }}>
            <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--accent-primary)' }}>
              送信先リスト確認（必須）
            </h3>

            {isDmTestMode() && (
              <div className="mb-3 p-2 rounded-lg text-[10px]" style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--accent-amber)' }}>
                DM_TEST_MODE: ON — ホワイトリスト以外への送信は自動ブロックされます
              </div>
            )}

            <div className="mb-3 grid grid-cols-2 gap-2 text-[10px]">
              <div className="glass-panel p-2 rounded-lg">
                <span style={{ color: 'var(--text-muted)' }}>送信先</span>
                <p className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{dmTargets.size}名</p>
              </div>
              <div className="glass-panel p-2 rounded-lg">
                <span style={{ color: 'var(--text-muted)' }}>キャンペーン</span>
                <p className="font-bold text-sm truncate" style={{ color: 'var(--accent-primary)' }}>{dmCampaign || '(未設定)'}</p>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto mb-3 glass-panel rounded-lg p-2" style={{ maxHeight: '300px' }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>送信対象ユーザー:</p>
              <div className="flex flex-wrap gap-1">
                {Array.from(dmTargets).map(u => (
                  <span key={u} className="text-[10px] px-2 py-0.5 rounded-full" style={{
                    background: DM_TEST_WHITELIST.has(u) ? 'rgba(34,197,94,0.15)' : 'rgba(15,23,42,0.6)',
                    border: `1px solid ${DM_TEST_WHITELIST.has(u) ? 'rgba(34,197,94,0.3)' : 'var(--border-glass)'}`,
                    color: DM_TEST_WHITELIST.has(u) ? 'var(--accent-green)' : 'var(--text-secondary)',
                  }}>
                    {u}{DM_TEST_WHITELIST.has(u) && ' (WL)'}
                  </span>
                ))}
              </div>
            </div>

            <div className="mb-3 glass-panel rounded-lg p-2">
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>メッセージ:</p>
              <p className="text-[11px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {dmMessage.length > 200 ? dmMessage.slice(0, 200) + '...' : dmMessage}
              </p>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setDmShowPreview(false); setDmPreviewConfirmed(false); }}
                className="btn-ghost text-xs py-2 px-4 flex-1">
                キャンセル
              </button>
              <button
                onClick={() => {
                  setDmPreviewConfirmed(true);
                  setDmShowPreview(false);
                  setTimeout(() => handleDmSend(), 100);
                }}
                className="text-xs py-2 px-4 flex-1 rounded-xl font-semibold"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary), #0284c7)', color: 'white' }}>
                {dmTargets.size}名への送信を確認
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
