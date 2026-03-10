'use client';

import { useState } from 'react';
import type { DMLogItem, ScenarioItem, EnrollmentDetail, SB } from '@/types/dm';

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
}

export default function DmCampaign({
  dmLogs, scenarios, setScenarios, scenariosLoading,
  scenarioEnrollCounts, scenarioEnrollDetails,
  accountId, castName, sb, section,
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

  if (section === 'campaigns') {
    return (
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold mb-3">📊 キャンペーン別集計</h3>
        {dmLogs.length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
        ) : (
          <div className="space-y-2">
            {(() => {
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
              return Array.from(campMap.entries())
                .sort((a, b) => b[1].total - a[1].total)
                .map(([campaign, stats]) => (
                  <div key={campaign} className="glass-panel px-4 py-3 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold truncate">{campaign}</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {stats.lastSent ? new Date(stats.lastSent).toLocaleDateString('ja-JP') : ''}
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden flex mb-2" style={{ background: 'rgba(0,0,0,0.2)' }}>
                      {stats.success > 0 && (
                        <div style={{ width: `${(stats.success / stats.total) * 100}%`, background: 'var(--accent-green)' }} />
                      )}
                      {stats.sending > 0 && (
                        <div style={{ width: `${(stats.sending / stats.total) * 100}%`, background: 'var(--accent-amber)' }} />
                      )}
                      {stats.queued > 0 && (
                        <div style={{ width: `${(stats.queued / stats.total) * 100}%`, background: 'var(--accent-primary)' }} />
                      )}
                      {stats.error > 0 && (
                        <div style={{ width: `${(stats.error / stats.total) * 100}%`, background: 'var(--accent-pink)' }} />
                      )}
                    </div>
                    <div className="flex gap-3 text-[10px]">
                      <span style={{ color: 'var(--text-muted)' }}>全{stats.total}件</span>
                      <span style={{ color: 'var(--accent-green)' }}>成功 {stats.success}</span>
                      {stats.error > 0 && <span style={{ color: 'var(--accent-pink)' }}>失敗 {stats.error}</span>}
                      {(stats.queued + stats.sending) > 0 && (
                        <span style={{ color: 'var(--accent-amber)' }}>処理中 {stats.queued + stats.sending}</span>
                      )}
                      {stats.total > 0 && (
                        <span style={{ color: 'var(--accent-primary)' }}>
                          成功率 {Math.round((stats.success / stats.total) * 1000) / 10}%
                        </span>
                      )}
                    </div>
                  </div>
                ));
            })()}
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
