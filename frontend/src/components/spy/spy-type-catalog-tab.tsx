'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { tokensToJPY } from '@/lib/utils';
import Link from 'next/link';
import { mapChatLog } from '@/lib/table-mappers';
import type { CastType } from '@/types';

const REVENUE_PATTERN_LABELS: Record<string, string> = {
  public_heavy: 'パブ重視型',
  ticket_rotation: 'チケチャ回転型',
  hybrid: 'ハイブリッド',
};

const CUSTOMER_QUALITY_LABELS: Record<string, string> = {
  whale_retention: '太客定着型',
  new_rotation: '新規回転型',
  mixed: 'ハイブリッド',
};

const FREQUENCY_LABELS: Record<string, string> = {
  daily: '毎日配信',
  weekly_3_4: '週3-4回',
  weekly_1_2: '週1-2回',
  irregular: '不定期',
};

const ROUTE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  harvest: { label: '収穫型', icon: '🌾', color: '#f59e0b' },
  nurture: { label: '育成型', icon: '🌱', color: '#22c55e' },
};

const GENRE_OPTIONS = ['絡み配信', '女性単体', 'カップル', 'グループ', 'その他'];
const CATEGORY_OPTIONS = ['人妻', '女子大生', 'ギャル', 'お姉さん', 'メンヘラ', 'ロリ', 'その他'];

const DEFAULT_CHECKLIST = [
  '配信時間帯がペルソナと整合しているか',
  'プロフィール文がペルソナと整合しているか',
  '配信タイトルにノイズがないか',
  '外見設定とライフスタイルが矛盾していないか',
  '発言内容がキャラクターから逸脱していないか',
];

export default function TypeCatalogTab() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [types, setTypes] = useState<CastType[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingType, setEditingType] = useState<CastType | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [castCounts, setCastCounts] = useState<Record<string, { count: number; names: string[] }>>({});

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }
      setAccountId(data.id);

      const { data: typesData } = await supabase
        .from('cast_types')
        .select('*')
        .eq('account_id', data.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(50);

      if (typesData) setTypes(typesData as CastType[]);

      const { data: spyCasts } = await supabase
        .from('spy_casts')
        .select('cast_name, cast_type_id')
        .eq('account_id', data.id)
        .filter('cast_type_id', 'not.is', null)
        .limit(100);

      const { data: regCasts } = await supabase
        .from('registered_casts')
        .select('cast_name, cast_type_id')
        .eq('account_id', data.id)
        .filter('cast_type_id', 'not.is', null)
        .limit(100);

      const counts: Record<string, { count: number; names: string[] }> = {};
      [...(spyCasts || []), ...(regCasts || [])].forEach((c: { cast_name: string; cast_type_id: string | null }) => {
        if (c.cast_type_id) {
          if (!counts[c.cast_type_id]) counts[c.cast_type_id] = { count: 0, names: [] };
          if (!counts[c.cast_type_id].names.includes(c.cast_name)) {
            counts[c.cast_type_id].count++;
            counts[c.cast_type_id].names.push(c.cast_name);
          }
        }
      });
      setCastCounts(counts);
      setLoading(false);
    });
  }, [user]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  if (isCreating || editingType) {
    return <TypeForm
      accountId={accountId!}
      existingType={editingType}
      onSave={(saved) => {
        if (editingType) {
          setTypes(prev => prev.map(t => t.id === saved.id ? saved : t));
        } else {
          setTypes(prev => [saved, ...prev]);
        }
        setEditingType(null);
        setIsCreating(false);
      }}
      onCancel={() => { setEditingType(null); setIsCreating(false); }}
    />;
  }

  return (
    <div className="space-y-4 overflow-y-auto flex-1 p-1">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold flex items-center gap-2">
          <span>型カタログ ({types.length})</span>
        </h2>
        <button onClick={() => setIsCreating(true)} className="btn-primary text-[11px] py-1.5 px-4">
          + 新しい型を作成
        </button>
      </div>

      {types.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <p className="text-3xl mb-4">📦</p>
          <h3 className="text-sm font-bold mb-2">型が登録されていません</h3>
          <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
            ベンチマークキャストの分析データから「型」を定義しましょう。
          </p>
          <button onClick={() => setIsCreating(true)} className="btn-primary text-[11px] py-2 px-6">
            最初の型を作成
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {types.map(type => (
            <TypeCard key={type.id} type={type} castInfo={castCounts[type.id]} onEdit={() => setEditingType(type)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TypeCard({ type, castInfo, onEdit }: { type: CastType; castInfo?: { count: number; names: string[] }; onEdit: () => void }) {
  const route = type.product_route ? ROUTE_LABELS[type.product_route] : null;

  return (
    <div className="glass-card p-5 hover:border-sky-500/20 transition-all">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold flex items-center gap-2">
          📦 {type.type_name}
        </h3>
        <button onClick={onEdit} className="btn-ghost text-[10px] py-1 px-3">編集</button>
      </div>

      {/* Benchmark */}
      <p className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)' }}>
        ベンチマーク: <span className="font-semibold text-sky-400">{type.benchmark_cast}</span>
      </p>

      {/* Category tags */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {type.category && <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7' }}>{type.category}</span>}
        {type.genre && <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>{type.genre}</span>}
      </div>

      {/* Revenue */}
      <div className="space-y-1.5 text-[11px] mb-3">
        {type.avg_session_revenue_min != null && type.avg_session_revenue_max != null && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>売上レンジ:</span>
            <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
              {type.avg_session_revenue_min.toLocaleString()}-{type.avg_session_revenue_max.toLocaleString()} tk/回
            </span>
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
              ({tokensToJPY(type.avg_session_revenue_min)}-{tokensToJPY(type.avg_session_revenue_max)})
            </span>
          </div>
        )}

        {type.revenue_pattern && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>収益:</span>
            <span>{REVENUE_PATTERN_LABELS[type.revenue_pattern] || type.revenue_pattern}</span>
            {type.ticket_ratio != null && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({type.ticket_ratio}%)</span>}
          </div>
        )}

        {type.customer_quality && (
          <div className="flex items-center gap-2">
            <span style={{ color: 'var(--text-muted)' }}>顧客:</span>
            <span>{CUSTOMER_QUALITY_LABELS[type.customer_quality] || type.customer_quality}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--text-muted)' }}>配信:</span>
          <span>
            {type.streaming_frequency ? FREQUENCY_LABELS[type.streaming_frequency] : '-'}
            {type.expected_lifespan_months && ` / 推定${type.expected_lifespan_months}ヶ月活動`}
          </span>
        </div>
      </div>

      {/* Route */}
      {route && (
        <div className="mb-3">
          <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: `${route.color}15`, color: route.color }}>
            {route.icon} {route.label}
          </span>
        </div>
      )}

      {/* Linked casts */}
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        紐付けキャスト: {castInfo?.count || 0}名
        {castInfo?.names && castInfo.names.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {castInfo.names.map(name => (
              <Link key={name} href={`/spy/${encodeURIComponent(name)}`}
                className="px-1.5 py-0.5 rounded text-[9px] hover:text-sky-400 transition-colors"
                style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--text-secondary)' }}>
                {name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypeForm({ accountId, existingType, onSave, onCancel }: {
  accountId: string;
  existingType: CastType | null;
  onSave: (saved: CastType) => void;
  onCancel: () => void;
}) {
  const [typeName, setTypeName] = useState(existingType?.type_name || '');
  const [benchmarkCast, setBenchmarkCast] = useState(existingType?.benchmark_cast || '');
  const [description, setDescription] = useState(existingType?.description || '');
  const [genre, setGenre] = useState(existingType?.genre || '');
  const [category, setCategory] = useState(existingType?.category || '');
  const [streamingStyle, setStreamingStyle] = useState(existingType?.streaming_style || '');
  const [revenuePattern, setRevenuePattern] = useState(existingType?.revenue_pattern || '');
  const [revenueMin, setRevenueMin] = useState<number | ''>(existingType?.avg_session_revenue_min ?? '');
  const [revenueMax, setRevenueMax] = useState<number | ''>(existingType?.avg_session_revenue_max ?? '');
  const [ticketRatio, setTicketRatio] = useState<number | ''>(existingType?.ticket_ratio ?? '');
  const [avgTicketPrice, setAvgTicketPrice] = useState<number | ''>(existingType?.avg_ticket_price ?? '');
  const [avgTicketAttendees, setAvgTicketAttendees] = useState<number | ''>(existingType?.avg_ticket_attendees ?? '');
  const [customerQuality, setCustomerQuality] = useState(existingType?.customer_quality || '');
  const [streamingFrequency, setStreamingFrequency] = useState(existingType?.streaming_frequency || '');
  const [expectedLifespan, setExpectedLifespan] = useState<number | ''>(existingType?.expected_lifespan_months ?? '');
  const [survivalRate, setSurvivalRate] = useState<number | ''>(existingType?.survival_rate_30d ?? '');
  const [productRoute, setProductRoute] = useState(existingType?.product_route || '');
  const [checklist, setChecklist] = useState<{ item: string; checked: boolean }[]>(
    existingType?.consistency_checklist && existingType.consistency_checklist.length > 0
      ? existingType.consistency_checklist
      : DEFAULT_CHECKLIST.map(item => ({ item, checked: false }))
  );
  const [hypothesis, setHypothesis] = useState(existingType?.hypothesis_1year || '');
  const [saving, setSaving] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [newCheckItem, setNewCheckItem] = useState('');

  const [availableCasts, setAvailableCasts] = useState<string[]>([]);

  useEffect(() => {
    const supabase = createClient();
    supabase.from('spy_casts')
      .select('cast_name')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('cast_name')
      .limit(100)
      .then(({ data }) => {
        if (data) setAvailableCasts(data.map((c: { cast_name: string }) => c.cast_name));
      });
  }, [accountId]);

  async function autoFillFromBenchmark() {
    if (!benchmarkCast) return;
    setAutoFilling(true);
    const supabase = createClient();

    try {
      const { data: sessions } = await supabase
        .from('sessions')
        .select('session_id, started_at, ended_at, ticket_shows, total_ticket_revenue, total_tip_revenue, total_ticket_attendees')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .filter('ended_at', 'not.is', null)
        .order('started_at', { ascending: false })
        .limit(500);

      const { data: rawTips } = await supabase
        .from('chat_logs')
        .select('timestamp, tokens')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .in('message_type', ['tip', 'gift'])
        .gt('tokens', 0)
        .order('timestamp', { ascending: false })
        .limit(10000);
      const tips = rawTips?.map(mapChatLog);

      if (sessions && sessions.length > 0 && tips) {
        const sessionRevenues: number[] = [];
        for (const s of sessions) {
          const sessionTips = tips.filter(t =>
            t.message_time >= s.started_at && t.message_time <= (s.ended_at || '')
          );
          const revenue = sessionTips.reduce((sum, t) => sum + (t.tokens || 0), 0);
          sessionRevenues.push(revenue);
        }

        if (sessionRevenues.length > 0) {
          const sorted = [...sessionRevenues].sort((a, b) => a - b);
          const p25 = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
          const p75 = sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1];
          setRevenueMin(Math.round(p25));
          setRevenueMax(Math.round(p75));
        }

        let totalTicketRev = 0;
        const totalAllRev = tips.reduce((s, t) => s + (t.tokens || 0), 0);
        let totalAttendees = 0;
        const ticketPrices: number[] = [];

        for (const s of sessions) {
          if (s.total_ticket_revenue) totalTicketRev += s.total_ticket_revenue;
          if (s.total_ticket_attendees) totalAttendees += s.total_ticket_attendees;
          if (s.ticket_shows) {
            const shows = typeof s.ticket_shows === 'string' ? JSON.parse(s.ticket_shows) : s.ticket_shows;
            if (Array.isArray(shows)) {
              shows.forEach((sh: { ticket_price?: number }) => { if (sh.ticket_price) ticketPrices.push(sh.ticket_price); });
            }
          }
        }

        if (totalAllRev > 0) setTicketRatio(Math.round(totalTicketRev / totalAllRev * 100));
        if (ticketPrices.length > 0) setAvgTicketPrice(Math.round(ticketPrices.reduce((a, b) => a + b, 0) / ticketPrices.length));
        const sessionsWithTickets = sessions.filter(s => s.total_ticket_attendees && s.total_ticket_attendees > 0);
        if (sessionsWithTickets.length > 0) {
          setAvgTicketAttendees(Math.round(totalAttendees / sessionsWithTickets.length));
        }

        const ratio = totalAllRev > 0 ? totalTicketRev / totalAllRev * 100 : 0;
        if (ratio >= 60) setRevenuePattern('ticket_rotation');
        else if (ratio <= 20) setRevenuePattern('public_heavy');
        else setRevenuePattern('hybrid');
      }

      const { data: castInfo } = await supabase
        .from('spy_casts')
        .select('genre, category, benchmark')
        .eq('account_id', accountId)
        .eq('cast_name', benchmarkCast)
        .limit(1)
        .maybeSingle();

      if (castInfo) {
        if (castInfo.genre && !genre) setGenre(castInfo.genre);
        if (castInfo.category && !category) setCategory(castInfo.category);
      }
    } catch (e) {
      console.error('Auto-fill failed:', e);
    }

    setAutoFilling(false);
  }

  async function handleSave() {
    if (!typeName || !benchmarkCast) return;
    setSaving(true);
    const supabase = createClient();

    const payload = {
      account_id: accountId,
      type_name: typeName,
      benchmark_cast: benchmarkCast,
      description: description || null,
      genre: genre || null,
      category: category || null,
      streaming_style: streamingStyle || null,
      revenue_pattern: revenuePattern || null,
      avg_session_revenue_min: revenueMin !== '' ? Number(revenueMin) : null,
      avg_session_revenue_max: revenueMax !== '' ? Number(revenueMax) : null,
      ticket_ratio: ticketRatio !== '' ? Number(ticketRatio) : null,
      avg_ticket_price: avgTicketPrice !== '' ? Number(avgTicketPrice) : null,
      avg_ticket_attendees: avgTicketAttendees !== '' ? Number(avgTicketAttendees) : null,
      customer_quality: customerQuality || null,
      streaming_frequency: streamingFrequency || null,
      expected_lifespan_months: expectedLifespan !== '' ? Number(expectedLifespan) : null,
      survival_rate_30d: survivalRate !== '' ? Number(survivalRate) : null,
      product_route: productRoute || null,
      consistency_checklist: checklist,
      hypothesis_1year: hypothesis || null,
      updated_at: new Date().toISOString(),
    };

    if (existingType) {
      const { data } = await supabase
        .from('cast_types')
        .update(payload)
        .eq('id', existingType.id)
        .select()
        .single();
      if (data) onSave(data as CastType);
    } else {
      const { data } = await supabase
        .from('cast_types')
        .insert(payload)
        .select()
        .single();
      if (data) onSave(data as CastType);
    }
    setSaving(false);
  }

  const inputCls = "input-glass w-full text-[12px] px-3 py-2";
  const labelCls = "block text-[11px] font-semibold mb-1";
  const sectionCls = "glass-card p-4 space-y-3";

  return (
    <div className="overflow-y-auto flex-1 space-y-4 p-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">
          {existingType ? `型を編集: ${existingType.type_name}` : '新しい型を作成'}
        </h2>
        <button onClick={onCancel} className="btn-ghost text-[11px] py-1.5 px-4">キャンセル</button>
      </div>

      {/* Basic Info */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>基本情報</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>型名 <span className="text-rose-400">*</span></label>
            <input className={inputCls} value={typeName} onChange={e => setTypeName(e.target.value)} placeholder="例: お姉さん系チケチャ型" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>ベンチマークキャスト <span className="text-rose-400">*</span></label>
            <div className="flex gap-2">
              {availableCasts.length > 0 ? (
                <select className={inputCls} value={benchmarkCast} onChange={e => setBenchmarkCast(e.target.value)}
                  style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
                  <option value="">選択してください</option>
                  {availableCasts.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input className={inputCls} value={benchmarkCast} onChange={e => setBenchmarkCast(e.target.value)} placeholder="キャスト名" />
              )}
              <button
                onClick={autoFillFromBenchmark}
                disabled={!benchmarkCast || autoFilling}
                className="btn-ghost text-[10px] py-1 px-3 whitespace-nowrap disabled:opacity-40"
              >
                {autoFilling ? '取得中...' : '自動入力'}
              </button>
            </div>
          </div>
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>説明</label>
          <textarea className={inputCls + " resize-none"} rows={2} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="この型の特徴や狙いを簡潔に" />
        </div>
      </div>

      {/* Section 1: Category Attributes */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>1</span>
          カテゴリー属性
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>ジャンル</label>
            <select className={inputCls} value={genre} onChange={e => setGenre(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              {GENRE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>カテゴリー</label>
            <select className={inputCls} value={category} onChange={e => setCategory(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>配信スタイル</label>
            <input className={inputCls} value={streamingStyle} onChange={e => setStreamingStyle(e.target.value)}
              placeholder="例: トーク+ゲーム" />
          </div>
        </div>
      </div>

      {/* Section 2: Revenue Pattern */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>2</span>
          収益パターン
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>収益パターン</label>
            <select className={inputCls} value={revenuePattern} onChange={e => setRevenuePattern(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="public_heavy">パブ重視型</option>
              <option value="ticket_rotation">チケチャ回転型</option>
              <option value="hybrid">ハイブリッド</option>
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>売上レンジ (tk/回)</label>
            <div className="flex items-center gap-1">
              <input className={inputCls} type="number" value={revenueMin} onChange={e => setRevenueMin(e.target.value ? Number(e.target.value) : '')} placeholder="min" />
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>-</span>
              <input className={inputCls} type="number" value={revenueMax} onChange={e => setRevenueMax(e.target.value ? Number(e.target.value) : '')} placeholder="max" />
            </div>
            {revenueMin !== '' && revenueMax !== '' && (
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {tokensToJPY(Number(revenueMin))} - {tokensToJPY(Number(revenueMax))}
              </p>
            )}
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>チケット比率 (%)</label>
            <input className={inputCls} type="number" min={0} max={100} value={ticketRatio} onChange={e => setTicketRatio(e.target.value ? Number(e.target.value) : '')} placeholder="0-100" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>平均チケット価格 (tk)</label>
            <input className={inputCls} type="number" value={avgTicketPrice} onChange={e => setAvgTicketPrice(e.target.value ? Number(e.target.value) : '')} placeholder="例: 50" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>平均チケット参加者数</label>
            <input className={inputCls} type="number" value={avgTicketAttendees} onChange={e => setAvgTicketAttendees(e.target.value ? Number(e.target.value) : '')} placeholder="例: 8" />
          </div>
        </div>
      </div>

      {/* Section 3: Customer Quality */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>3</span>
          顧客の質
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>顧客タイプ</label>
            <select className={inputCls} value={customerQuality} onChange={e => setCustomerQuality(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="whale_retention">太客定着型</option>
              <option value="new_rotation">新規回転型</option>
              <option value="mixed">ハイブリッド</option>
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>配信頻度</label>
            <select className={inputCls} value={streamingFrequency} onChange={e => setStreamingFrequency(e.target.value)}
              style={{ background: 'rgba(15, 23, 42, 0.5)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }}>
              <option value="">未設定</option>
              <option value="daily">毎日配信</option>
              <option value="weekly_3_4">週3-4回</option>
              <option value="weekly_1_2">週1-2回</option>
              <option value="irregular">不定期</option>
            </select>
          </div>
        </div>
      </div>

      {/* Section 4: Survival Pattern */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1.5"
            style={{ background: 'rgba(56,189,248,0.15)', color: '#38bdf8' }}>4</span>
          生存パターン
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>推定活動期間 (ヶ月)</label>
            <input className={inputCls} type="number" value={expectedLifespan} onChange={e => setExpectedLifespan(e.target.value ? Number(e.target.value) : '')} placeholder="例: 6" />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>30日生存率 (%)</label>
            <input className={inputCls} type="number" min={0} max={100} value={survivalRate} onChange={e => setSurvivalRate(e.target.value ? Number(e.target.value) : '')} placeholder="0-100" />
          </div>
        </div>
      </div>

      {/* Product Route */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold mb-2" style={{ color: 'var(--accent-primary)' }}>プロダクトルート</h3>
        <div className="flex gap-3">
          {(['harvest', 'nurture'] as const).map(r => {
            const info = ROUTE_LABELS[r];
            const isSelected = productRoute === r;
            return (
              <button
                key={r}
                onClick={() => setProductRoute(isSelected ? '' : r)}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all"
                style={{
                  background: isSelected ? `${info.color}15` : 'rgba(15,23,42,0.4)',
                  color: isSelected ? info.color : 'var(--text-muted)',
                  border: `1px solid ${isSelected ? info.color + '40' : 'var(--border-glass)'}`,
                }}
              >
                <span className="text-lg">{info.icon}</span>
                {info.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Consistency Checklist */}
      <div className={sectionCls}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>一貫性チェックリスト</h3>
          <button
            onClick={() => setChecklist(DEFAULT_CHECKLIST.map(item => ({ item, checked: false })))}
            className="btn-ghost text-[9px] py-0.5 px-2"
          >
            デフォルトに戻す
          </button>
        </div>
        <div className="space-y-1.5">
          {checklist.map((c, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <input
                type="checkbox"
                checked={c.checked}
                onChange={() => {
                  const next = [...checklist];
                  next[i] = { ...next[i], checked: !next[i].checked };
                  setChecklist(next);
                }}
                className="rounded border-gray-600 bg-gray-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-0"
              />
              <span className="text-[11px] flex-1" style={{ color: c.checked ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{c.item}</span>
              <button
                onClick={() => setChecklist(prev => prev.filter((_, idx) => idx !== i))}
                className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: 'var(--accent-pink)' }}
              >
                削除
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input
            className={inputCls}
            value={newCheckItem}
            onChange={e => setNewCheckItem(e.target.value)}
            placeholder="チェック項目を追加..."
            onKeyDown={e => {
              if (e.key === 'Enter' && newCheckItem.trim()) {
                setChecklist(prev => [...prev, { item: newCheckItem.trim(), checked: false }]);
                setNewCheckItem('');
              }
            }}
          />
          <button
            onClick={() => {
              if (newCheckItem.trim()) {
                setChecklist(prev => [...prev, { item: newCheckItem.trim(), checked: false }]);
                setNewCheckItem('');
              }
            }}
            className="btn-ghost text-[10px] py-1 px-3 whitespace-nowrap"
          >
            追加
          </button>
        </div>
      </div>

      {/* 1-Year Hypothesis */}
      <div className={sectionCls}>
        <h3 className="text-[12px] font-bold" style={{ color: 'var(--accent-primary)' }}>1年仮説</h3>
        <textarea
          className={inputCls + " resize-none"}
          rows={3}
          value={hypothesis}
          onChange={e => setHypothesis(e.target.value)}
          placeholder="この型のキャストが1年後にどうなっているか。目標売上、成長シナリオなど。"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pb-4">
        <button onClick={onCancel} className="btn-ghost text-[11px] py-2 px-5">キャンセル</button>
        <button
          onClick={handleSave}
          disabled={!typeName || !benchmarkCast || saving}
          className="btn-primary text-[11px] py-2 px-6 disabled:opacity-40"
        >
          {saving ? '保存中...' : existingType ? '更新する' : '作成する'}
        </button>
      </div>
    </div>
  );
}
