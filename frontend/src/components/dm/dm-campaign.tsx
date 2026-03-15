'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DMLogItem, ScenarioItem, EnrollmentDetail, SB } from '@/types/dm';

interface RetentionData {
  total_sent: number;
  returned_count: number;
  retention_rate: number;
  earliest_dm: string;
  latest_dm: string;
  period_ended: boolean;
}

/** C-3: Parse campaign name — strip pipe3_ prefix, parse _bulk_YYYYMMDD_HHMM to Japanese date */
function parseCampaignName(raw: string): { displayName: string; dateLabel: string | null } {
  let name = raw;
  // Strip pipe3_ prefix
  if (name.startsWith('pipe3_')) name = name.slice(6);
  // Parse _bulk_YYYYMMDD_HHMM suffix
  const bulkMatch = name.match(/_bulk_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/);
  if (bulkMatch) {
    const [, y, m, d, hh, mm] = bulkMatch;
    name = name.replace(/_bulk_\d{8}_\d{4}$/, '');
    return { displayName: name, dateLabel: `${Number(m)}/${Number(d)} ${hh}:${mm}` };
  }
  return { displayName: name, dateLabel: null };
}

interface DmCampaignProps {
  dmLogs: DMLogItem[];
  scenarios: ScenarioItem[];
  setScenarios: React.Dispatch<React.SetStateAction<ScenarioItem[]>>;
  scenariosLoading: boolean;
  scenarioEnrollCounts: Map<string, number>;
  scenarioEnrollDetails: Map<string, EnrollmentDetail[]>;
  accountId: string;
  castName: string;
  sb: SB;
  /** 'campaigns' or 'scenarios' sub-section */
  section: 'campaigns' | 'scenarios';
  onRefresh?: () => void;
}

export default function DmCampaign({
  dmLogs, scenarios, setScenarios, scenariosLoading,
  scenarioEnrollCounts, scenarioEnrollDetails,
  accountId, castName, sb, section, onRefresh,
}: DmCampaignProps) {
  // Scenario creation state
  const [scenarioCreating, setScenarioCreating] = useState(false);
  const [newScenario, setNewScenario] = useState({ name: '', triggerType: 'first_payment', config: '{}' });
  const [scenarioExpanded, setScenarioExpanded] = useState<string | null>(null);
  const [enrollExpanded, setEnrollExpanded] = useState<Set<string>>(new Set());
  const [scenarioProcessing, setScenarioProcessing] = useState(false);
  const [scenarioProcessResult, setScenarioProcessResult] = useState<{
    processed: number; errors: number; skipped: number; aiGenerated: number; aiErrors: number;
  } | null>(null);

  // Retention data per campaign
  const [retentionMap, setRetentionMap] = useState<Map<string, RetentionData>>(new Map());
  const [deleting, setDeleting] = useState<string | null>(null);
  // C-1: Per-campaign expanded state
  const [campaignExpanded, setCampaignExpanded] = useState<Set<string>>(new Set());
  // C-2: Per-campaign slider days
  const [sliderDaysMap, setSliderDaysMap] = useState<Map<string, number>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Fetch retention data for all campaigns (batch)
  const fetchRetention = useCallback(async (campaigns: string[], daysOverride?: number) => {
    const results = new Map<string, RetentionData>();
    for (const campaign of campaigns) {
      try {
        const days = daysOverride ?? sliderDaysMap.get(campaign) ?? 14;
        const { data } = await sb.rpc('get_campaign_retention', {
          p_account_id: accountId,
          p_cast_name: castName,
          p_campaign_tag: campaign,
          p_retention_days: days,
        });
        if (data && Array.isArray(data) && data.length > 0) {
          results.set(campaign, data[0] as RetentionData);
        } else if (data && !Array.isArray(data)) {
          results.set(campaign, data as RetentionData);
        }
      } catch { /* ignore individual failures */ }
    }
    setRetentionMap(prev => {
      const merged = new Map(prev);
      Array.from(results.entries()).forEach(([k, v]) => merged.set(k, v));
      return merged;
    });
  }, [sb, accountId, castName, sliderDaysMap]);

  // C-2: Fetch single campaign retention with specific days (for slider)
  const fetchSingleRetention = useCallback(async (campaign: string, days: number) => {
    try {
      const { data } = await sb.rpc('get_campaign_retention', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_campaign_tag: campaign,
        p_retention_days: days,
      });
      if (data) {
        const row = Array.isArray(data) && data.length > 0 ? data[0] : (!Array.isArray(data) ? data : null);
        if (row) {
          setRetentionMap(prev => {
            const next = new Map(prev);
            next.set(campaign, row as RetentionData);
            return next;
          });
        }
      }
    } catch { /* ignore */ }
  }, [sb, accountId, castName]);

  // C-2: Handle slider change with 300ms debounce
  const handleSliderChange = useCallback((campaign: string, days: number) => {
    setSliderDaysMap(prev => {
      const next = new Map(prev);
      next.set(campaign, days);
      return next;
    });
    // Debounce RPC call
    const existing = debounceTimers.current.get(campaign);
    if (existing) clearTimeout(existing);
    debounceTimers.current.set(campaign, setTimeout(() => {
      fetchSingleRetention(campaign, days);
      debounceTimers.current.delete(campaign);
    }, 300));
  }, [fetchSingleRetention]);

  // Auto-fetch retention when campaigns section loads
  useEffect(() => {
    if (section !== 'campaigns' || dmLogs.length === 0) return;
    const campaigns = Array.from(new Set(dmLogs.map(l => l.campaign || '(タグなし)').filter(c => c !== '(タグなし)')));
    if (campaigns.length > 0) fetchRetention(campaigns);
  }, [section, dmLogs, fetchRetention]);

  // Delete campaign handler
  const handleDeleteCampaign = async (campaign: string) => {
    if (!confirm(`キャンペーン '${campaign}' のDM送信ログを削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(campaign);
    try {
      await sb.from('dm_send_log')
        .delete()
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .eq('campaign', campaign);
      onRefresh?.();
    } catch (e) {
      alert('削除エラー: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDeleting(null);
    }
  };

  if (section === 'campaigns') {
    // Build campaign stats map
    const campMap = new Map<string, { total: number; success: number; error: number; sending: number; queued: number; lastSent: string | null }>();
    for (const log of dmLogs) {
      const c = log.campaign || '(タグなし)';
      if (!campMap.has(c)) {
        campMap.set(c, { total: 0, success: 0, error: 0, sending: 0, queued: 0, lastSent: null });
      }
      const entry = campMap.get(c)!;
      entry.total++;
      if (log.status === 'success') { entry.success++; if (!entry.lastSent || (log.sent_at && log.sent_at > entry.lastSent)) entry.lastSent = log.sent_at; }
      else if (log.status === 'error') entry.error++;
      else if (log.status === 'sending') entry.sending++;
      else if (log.status === 'queued') entry.queued++;
    }
    const sortedCampaigns = Array.from(campMap.entries()).sort((a, b) => b[1].total - a[1].total);

    return (
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold mb-3">📊 キャンペーン別集計</h3>
        {dmLogs.length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
        ) : (
          <div className="space-y-2">
            {sortedCampaigns.map(([campaign, stats]) => {
              const ret = retentionMap.get(campaign);
              const retColor = ret
                ? Number(ret.retention_rate) >= 50 ? '#22c55e'
                  : Number(ret.retention_rate) >= 30 ? '#f59e0b'
                  : '#ef4444'
                : undefined;
              const isOpen = campaignExpanded.has(campaign);
              const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 1000) / 10 : 0;
              const { displayName, dateLabel } = parseCampaignName(campaign);
              const days = sliderDaysMap.get(campaign) ?? 14;

              return (
                <div key={campaign} className="glass-panel rounded-xl overflow-hidden">
                  {/* C-1: Collapsed header — clickable accordion */}
                  <div
                    className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.02] transition-colors"
                    onClick={() => setCampaignExpanded(prev => {
                      const next = new Set(prev);
                      if (next.has(campaign)) next.delete(campaign); else next.add(campaign);
                      return next;
                    })}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-[11px] font-bold truncate">{displayName}</span>
                      {dateLabel && (
                        <span className="text-[10px] shrink-0 px-1.5 py-0.5 rounded" style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                          {dateLabel}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] shrink-0">
                      <span style={{ color: 'var(--accent-green)' }}>成功率 {successRate}%</span>
                      {ret && (
                        <span style={{ color: retColor }}>
                          CVR {ret.retention_rate ?? 0}%
                        </span>
                      )}
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {/* C-1: Expanded detail */}
                  {isOpen && (
                    <div className="px-4 pb-3 space-y-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      {/* Progress bar */}
                      <div className="h-2 rounded-full overflow-hidden flex mt-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
                        {stats.success > 0 && <div style={{ width: `${(stats.success / stats.total) * 100}%`, background: 'var(--accent-green)' }} />}
                        {stats.sending > 0 && <div style={{ width: `${(stats.sending / stats.total) * 100}%`, background: 'var(--accent-amber)' }} />}
                        {stats.queued > 0 && <div style={{ width: `${(stats.queued / stats.total) * 100}%`, background: 'var(--accent-primary)' }} />}
                        {stats.error > 0 && <div style={{ width: `${(stats.error / stats.total) * 100}%`, background: 'var(--accent-pink)' }} />}
                      </div>

                      {/* Send stats */}
                      <div className="flex flex-wrap gap-3 text-[10px]">
                        <span style={{ color: 'var(--text-muted)' }}>全{stats.total}件</span>
                        <span style={{ color: 'var(--accent-green)' }}>成功 {stats.success}</span>
                        {stats.error > 0 && <span style={{ color: 'var(--accent-pink)' }}>失敗 {stats.error}</span>}
                        {(stats.queued + stats.sending) > 0 && <span style={{ color: 'var(--accent-amber)' }}>処理中 {stats.queued + stats.sending}</span>}
                        {stats.lastSent && <span style={{ color: 'var(--text-muted)' }}>最終: {new Date(stats.lastSent).toLocaleDateString('ja-JP')}</span>}
                      </div>

                      {/* C-2: Retention slider + presets */}
                      {ret && (
                        <div className="space-y-2 pt-1" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)' }}>
                              リテンション判定期間: {days}日
                            </span>
                            <div className="flex items-center gap-1">
                              {[1, 7, 14, 30].map(preset => (
                                <button
                                  key={preset}
                                  onClick={() => handleSliderChange(campaign, preset)}
                                  className="text-[9px] px-1.5 py-0.5 rounded transition-colors"
                                  style={{
                                    background: days === preset ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.05)',
                                    color: days === preset ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    border: days === preset ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent',
                                  }}
                                >
                                  {preset}日
                                </button>
                              ))}
                            </div>
                          </div>
                          <input
                            type="range"
                            min={1}
                            max={30}
                            value={days}
                            onChange={e => handleSliderChange(campaign, Number(e.target.value))}
                            className="w-full h-1 rounded-lg appearance-none cursor-pointer"
                            style={{ accentColor: 'var(--accent-primary)', background: 'rgba(255,255,255,0.1)' }}
                          />

                          {/* CVR detail */}
                          <div className="flex items-center gap-2 text-[10px]">
                            <span style={{ color: 'var(--text-muted)' }}>CVR:</span>
                            {ret.period_ended ? (
                              <span style={{ color: retColor }}>
                                {ret.returned_count}/{ret.total_sent}人 ({ret.retention_rate}%)
                              </span>
                            ) : (() => {
                              const latestDm = new Date(ret.latest_dm);
                              const endDate = new Date(latestDm.getTime() + days * 24 * 60 * 60 * 1000);
                              const remaining = Math.max(0, Math.ceil((endDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
                              return (
                                <span style={{ color: 'var(--accent-amber)' }}>
                                  判定中（残り{remaining}日）{ret.returned_count > 0 && ` — 暫定 ${ret.returned_count}/${ret.total_sent}人 (${ret.retention_rate}%)`}
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      )}

                      {/* Delete button */}
                      <div className="flex justify-end">
                        <button
                          onClick={() => handleDeleteCampaign(campaign)}
                          disabled={deleting === campaign}
                          className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-red-500/20"
                          style={{ color: deleting === campaign ? 'var(--text-muted)' : '#ef4444' }}
                        >
                          {deleting === campaign ? '削除中...' : '🗑️ 削除'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // section === 'scenarios'
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold">📋 DMシナリオ</h3>
        <div className="flex items-center gap-2">
          <button
            disabled={scenarioProcessing || !accountId}
            onClick={async () => {
              if (!accountId) return;
              setScenarioProcessing(true);
              setScenarioProcessResult(null);
              try {
                const { data: { session } } = await sb.auth.getSession();
                const res = await fetch('/api/scenario/process', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token || ''}`,
                  },
                  body: JSON.stringify({ account_id: accountId }),
                });
                const result = await res.json();
                if (res.ok) {
                  setScenarioProcessResult(result);
                } else {
                  alert(result.error || 'キュー処理失敗');
                }
              } catch (e) {
                alert('キュー処理エラー: ' + (e instanceof Error ? e.message : ''));
              } finally {
                setScenarioProcessing(false);
              }
            }}
            className="text-[10px] px-2 py-1 rounded-lg disabled:opacity-40"
            style={{
              background: 'rgba(34,197,94,0.12)',
              border: '1px solid rgba(34,197,94,0.3)',
              color: 'var(--accent-green)',
            }}
          >
            {scenarioProcessing ? '処理中...' : '▶ キュー実行'}
          </button>
          <button
            onClick={() => setScenarioCreating(!scenarioCreating)}
            className="text-[10px] px-2 py-1 rounded-lg"
            style={{
              background: 'rgba(56,189,248,0.12)',
              border: '1px solid rgba(56,189,248,0.3)',
              color: 'var(--accent-primary)',
            }}
          >
            {scenarioCreating ? '✕ 閉じる' : '＋ 新規作成'}
          </button>
        </div>
      </div>

      {/* キュー処理結果 */}
      {scenarioProcessResult && (
        <div className="glass-panel rounded-lg p-2 mb-3 flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--accent-green)' }}>処理: {scenarioProcessResult.processed}件</span>
          {scenarioProcessResult.aiGenerated > 0 && (
            <span style={{ color: 'var(--accent-purple)' }}>AI生成: {scenarioProcessResult.aiGenerated}件</span>
          )}
          {scenarioProcessResult.skipped > 0 && (
            <span style={{ color: 'var(--text-muted)' }}>スキップ: {scenarioProcessResult.skipped}件</span>
          )}
          {scenarioProcessResult.errors > 0 && (
            <span style={{ color: 'var(--accent-pink)' }}>エラー: {scenarioProcessResult.errors}件</span>
          )}
          {scenarioProcessResult.aiErrors > 0 && (
            <span style={{ color: 'var(--accent-amber)' }}>AI失敗(テンプレ代替): {scenarioProcessResult.aiErrors}件</span>
          )}
        </div>
      )}

      {/* 新規作成フォーム */}
      {scenarioCreating && (
        <div className="glass-panel rounded-lg p-3 mb-3 space-y-2">
          <input
            className="input-glass text-xs w-full"
            placeholder="シナリオ名（例: 初回応援お礼）"
            value={newScenario.name}
            onChange={e => setNewScenario(prev => ({ ...prev, name: e.target.value }))}
          />
          <select
            className="input-glass text-xs w-full"
            value={newScenario.triggerType}
            onChange={e => setNewScenario(prev => ({ ...prev, triggerType: e.target.value }))}
          >
            <option value="first_payment">初回応援</option>
            <option value="high_payment">高額応援</option>
            <option value="visit_no_action">来訪（応援なし）</option>
            <option value="dormant">離脱（N日不在）</option>
            <option value="segment_change">セグメント変化</option>
            <option value="manual">手動エンロール</option>
            <option value="thankyou_vip">VIPお礼</option>
            <option value="thankyou_regular">常連お礼</option>
            <option value="thankyou_first">初回お礼</option>
            <option value="churn_recovery">離脱防止</option>
          </select>
          {newScenario.triggerType === 'dormant' && (
            <input
              className="input-glass text-xs w-full"
              placeholder='設定JSON（例: {"days": 7}）'
              value={newScenario.config}
              onChange={e => setNewScenario(prev => ({ ...prev, config: e.target.value }))}
            />
          )}
          <button
            className="btn-primary text-xs px-3 py-1.5 w-full"
            disabled={!newScenario.name.trim()}
            onClick={async () => {
              if (!accountId || !newScenario.name.trim()) return;
              const dupName = newScenario.name.trim();
              if (scenarios.some(s => s.scenario_name === dupName)) {
                alert('同じ名前のシナリオが既に存在します: ' + dupName);
                return;
              }
              let config = {};
              try { config = JSON.parse(newScenario.config); } catch { /* ignore */ }
              const { error } = await sb.from('dm_scenarios').insert({
                account_id: accountId,
                scenario_name: newScenario.name.trim(),
                trigger_type: newScenario.triggerType,
                trigger_config: config,
                segment_targets: [],
                steps: [],
                is_active: true,
                auto_approve_step0: true,
                daily_send_limit: 50,
                min_interval_hours: 24,
              });
              if (error) {
                if (error.code === '23505') {
                  alert('同じ名前のシナリオが既に存在します');
                } else {
                  alert('作成失敗: ' + error.message);
                }
                return;
              }
              setScenarioCreating(false);
              setNewScenario({ name: '', triggerType: 'first_payment', config: '{}' });
              const { data: fresh } = await sb.from('dm_scenarios')
                .select('*').eq('account_id', accountId).order('created_at', { ascending: false });
              setScenarios((fresh || []) as ScenarioItem[]);
            }}
          >
            作成
          </button>
        </div>
      )}

      {/* シナリオ一覧 */}
      {scenariosLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
          ))}
        </div>
      ) : scenarios.length === 0 ? (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
          シナリオが登録されていません
        </p>
      ) : (
        <div className="space-y-2">
          {scenarios.map(sc => {
            const triggerLabels: Record<string, string> = {
              first_payment: '初回応援', high_payment: '高額応援',
              visit_no_action: '来訪（応援なし）', dormant: '離脱',
              segment_change: 'セグメント変化', manual: '手動',
              thankyou_vip: 'VIPお礼', thankyou_regular: '常連お礼',
              thankyou_first: '初回お礼', churn_recovery: '離脱防止',
            };
            const enrollCount = scenarioEnrollCounts.get(sc.id) || 0;
            const isExpanded = scenarioExpanded === sc.id;
            return (
              <div key={sc.id} className="glass-panel rounded-lg overflow-hidden">
                <div
                  className="px-3 py-2.5 flex items-center justify-between cursor-pointer hover:bg-white/[0.02]"
                  onClick={() => setScenarioExpanded(isExpanded ? null : sc.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${sc.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                    <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
                      {sc.scenario_name}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                      background: 'rgba(167,139,250,0.12)',
                      color: 'var(--accent-purple)',
                    }}>
                      {triggerLabels[sc.trigger_type] || sc.trigger_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{(sc.steps || []).length}ステップ</span>
                    {enrollCount > 0 && (
                      <span style={{ color: 'var(--accent-primary)' }}>{enrollCount}名進行中</span>
                    )}
                    <span>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-2">
                    {/* Toggle active */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {sc.is_active ? '有効' : '無効'}
                      </span>
                      <button
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={{
                          background: sc.is_active ? 'rgba(244,63,94,0.12)' : 'rgba(34,197,94,0.12)',
                          color: sc.is_active ? 'var(--accent-pink)' : 'var(--accent-green)',
                        }}
                        onClick={async (e) => {
                          e.stopPropagation();
                          await sb.from('dm_scenarios').update({ is_active: !sc.is_active }).eq('id', sc.id);
                          setScenarios(prev => prev.map(s => s.id === sc.id ? { ...s, is_active: !s.is_active } : s));
                        }}
                      >
                        {sc.is_active ? '無効にする' : '有効にする'}
                      </button>
                    </div>

                    {/* Config info */}
                    {sc.trigger_config && Object.keys(sc.trigger_config).length > 0 && (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        設定: {JSON.stringify(sc.trigger_config)}
                      </p>
                    )}
                    {sc.segment_targets && sc.segment_targets.length > 0 && (
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        対象セグメント: {sc.segment_targets.join(', ')}
                      </p>
                    )}

                    {/* Steps */}
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-bold" style={{ color: 'var(--text-secondary)' }}>ステップ一覧:</p>
                      {(sc.steps || []).length === 0 ? (
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ステップ未設定</p>
                      ) : (
                        (sc.steps || []).map((step, i) => (
                          <div key={i} className="flex items-start gap-2 text-[10px] rounded px-2 py-1.5"
                            style={{ background: 'rgba(0,0,0,0.15)' }}>
                            <span className="font-bold shrink-0" style={{ color: 'var(--accent-primary)' }}>
                              Step {i}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p style={{ color: 'var(--text-muted)' }}>
                                {step.delay_hours > 0 ? `${step.delay_hours}時間後` : '即時'}
                                {step.goal && ` → ゴール: ${step.goal}`}
                              </p>
                              <p className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                {step.message || step.template}
                              </p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Limits info */}
                    <div className="flex gap-3 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <span>日次上限: {sc.daily_send_limit}</span>
                      <span>最小間隔: {sc.min_interval_hours}h</span>
                      <span>Step0自動: {sc.auto_approve_step0 ? 'ON' : 'OFF'}</span>
                    </div>

                    {/* エンロールメント詳細リスト */}
                    {enrollCount > 0 && (() => {
                      const details = scenarioEnrollDetails.get(sc.id) || [];
                      const isEnrollOpen = enrollExpanded.has(sc.id);
                      const displayLimit = 30;
                      const visibleEnrolls = isEnrollOpen ? details.slice(0, displayLimit) : [];
                      return (
                        <div className="mt-1">
                          <button
                            onClick={() => setEnrollExpanded(prev => {
                              const next = new Set(prev);
                              if (next.has(sc.id)) next.delete(sc.id); else next.add(sc.id);
                              return next;
                            })}
                            className="flex items-center gap-2 text-[10px] font-semibold w-full text-left hover:opacity-80 transition-opacity py-1"
                            style={{ color: 'var(--accent-primary)' }}
                          >
                            <span>{isEnrollOpen ? '▼' : '▶'}</span>
                            <span>進行中ユーザー（{enrollCount}名）</span>
                          </button>
                          {isEnrollOpen && (
                            <div className="space-y-0.5 max-h-60 overflow-auto mt-1">
                              {visibleEnrolls.map(e => (
                                <div key={e.user_name} className="flex items-center justify-between text-[10px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                  <span className="truncate font-medium" style={{ color: 'var(--text-secondary)' }}>
                                    {e.user_name}
                                  </span>
                                  <div className="flex items-center gap-2 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                                    <span className="px-1.5 py-0.5 rounded" style={{
                                      background: 'rgba(56,189,248,0.1)',
                                      color: 'var(--accent-primary)',
                                    }}>
                                      Step {e.current_step}
                                    </span>
                                    <span>{new Date(e.enrolled_at).toLocaleDateString('ja-JP')}</span>
                                  </div>
                                </div>
                              ))}
                              {details.length > displayLimit && (
                                <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                                  ... 他 {details.length - displayLimit}名
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
