'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/components/auth-provider';

// ============================================================
// Types
// ============================================================
interface ScenarioStep {
  step: number;
  delay_hours: number;
  template: string;
  message: string;
  goal?: string;
  use_persona?: boolean;
}

interface Scenario {
  id: string;
  account_id: string;
  scenario_name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  segment_targets: string[];
  steps: ScenarioStep[];
  is_active: boolean;
  auto_approve_step0: boolean;
  daily_send_limit: number;
  min_interval_hours: number;
  created_at: string;
  updated_at: string;
}

interface Enrollment {
  id: string;
  scenario_id: string;
  account_id: string;
  cast_name: string | null;
  username: string;
  current_step: number;
  status: string;
  next_step_due_at: string | null;
  last_step_sent_at: string | null;
  goal_type: string | null;
  goal_reached_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface EnrollmentStats {
  scenario_id: string;
  active: number;
  completed: number;
  goal_reached: number;
  total: number;
}

const TRIGGER_TYPES = [
  { value: 'thankyou_vip', label: 'VIPお礼' },
  { value: 'thankyou_regular', label: '常連お礼' },
  { value: 'thankyou_first', label: '初課金お礼' },
  { value: 'first_payment', label: '初課金検出' },
  { value: 'high_payment', label: '高額応援' },
  { value: 'churn_recovery', label: '離脱防止' },
  { value: 'dormant', label: '長期不在' },
  { value: 'visit_no_action', label: '来訪フォロー' },
  { value: 'segment_change', label: 'セグメント変動' },
  { value: 'manual', label: '手動' },
] as const;

const SEGMENTS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];

function getTriggerLabel(type: string): string {
  return TRIGGER_TYPES.find(t => t.value === type)?.label || type;
}

function formatDate(d: string | null): string {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return d; }
}

// ============================================================
// Main Component
// ============================================================
export default function ScenariosPage() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [enrollmentStats, setEnrollmentStats] = useState<EnrollmentStats[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [processResult, setProcessResult] = useState<string | null>(null);
  const [editingScenario, setEditingScenario] = useState<Partial<Scenario> | null>(null);
  const [tab, setTab] = useState<'list' | 'enrollments'>('list');

  const supabase = createClient();

  // Account ID取得
  useEffect(() => {
    if (!user) return;
    supabase.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // シナリオ一覧取得
  const fetchScenarios = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase
      .from('dm_scenarios')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    setScenarios(data || []);

    // エンロールメント統計
    const { data: enrollData } = await supabase
      .from('dm_scenario_enrollments')
      .select('scenario_id, status')
      .eq('account_id', accountId);

    if (enrollData) {
      const statsMap = new Map<string, EnrollmentStats>();
      for (const e of enrollData) {
        const s = statsMap.get(e.scenario_id) || { scenario_id: e.scenario_id, active: 0, completed: 0, goal_reached: 0, total: 0 };
        s.total++;
        if (e.status === 'active') s.active++;
        else if (e.status === 'completed') s.completed++;
        else if (e.status === 'goal_reached') s.goal_reached++;
        statsMap.set(e.scenario_id, s);
      }
      setEnrollmentStats(Array.from(statsMap.values()));
    }
    setLoading(false);
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchScenarios(); }, [fetchScenarios]);

  // エンロールメント詳細取得
  const fetchEnrollments = useCallback(async (scenarioId: string) => {
    const { data } = await supabase
      .from('dm_scenario_enrollments')
      .select('*')
      .eq('scenario_id', scenarioId)
      .order('created_at', { ascending: false })
      .limit(100);
    setEnrollments(data || []);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // シナリオ有効/無効トグル
  const toggleActive = async (id: string, current: boolean) => {
    await supabase.from('dm_scenarios').update({ is_active: !current }).eq('id', id);
    fetchScenarios();
  };

  // シナリオ削除
  const deleteScenario = async (id: string) => {
    if (!confirm('このシナリオを削除しますか？関連するエンロールメントも全て削除されます。')) return;
    await supabase.from('dm_scenario_enrollments').delete().eq('scenario_id', id);
    await supabase.from('dm_scenarios').delete().eq('id', id);
    if (selectedScenario?.id === id) {
      setSelectedScenario(null);
      setEnrollments([]);
    }
    fetchScenarios();
  };

  // キュー処理実行
  const processQueue = async () => {
    if (!accountId) return;
    setProcessing(true);
    setProcessResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/scenario/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      });
      const result = await res.json();
      if (result.success) {
        setProcessResult(`処理: ${result.processed}件 / AI生成: ${result.aiGenerated}件 / スキップ: ${result.skipped}件 / エラー: ${result.errors}件`);
      } else {
        setProcessResult(`エラー: ${result.error || 'unknown'}`);
      }
      fetchScenarios();
    } catch (e) {
      setProcessResult(`通信エラー: ${e}`);
    } finally {
      setProcessing(false);
    }
  };

  // シナリオ保存（新規/更新）
  const saveScenario = async () => {
    if (!editingScenario || !accountId) return;
    const payload = {
      ...editingScenario,
      account_id: accountId,
    };
    if (editingScenario.id) {
      await supabase.from('dm_scenarios').update(payload).eq('id', editingScenario.id);
    } else {
      await supabase.from('dm_scenarios').insert(payload);
    }
    setEditingScenario(null);
    fetchScenarios();
  };

  // AI文面プレビュー
  const [previewMsg, setPreviewMsg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAiMessage = async (scenario: Scenario) => {
    setPreviewLoading(true);
    setPreviewMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/persona', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          mode: 'ai',
          cast_name: 'hanshakun',
          account_id: accountId,
          task_type: 'dm_generate',
          context: {
            user_name: 'test_user',
            cast_name: 'hanshakun',
            account_id: accountId,
            scenario_type: scenario.trigger_type,
            step_number: 1,
            scenario_purpose: `${getTriggerLabel(scenario.trigger_type)}シナリオのプレビュー`,
            step_tone_guide: 'Step 1: 最初の接触。軽く自然に。感謝ベース。',
          },
        }),
      });
      const data = await res.json();
      const msg = typeof data.output === 'object' ? data.output?.message : data.output;
      setPreviewMsg(msg || data.message || JSON.stringify(data.output));
    } catch (e) {
      setPreviewMsg(`エラー: ${e}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const getStats = (scenarioId: string): EnrollmentStats =>
    enrollmentStats.find(s => s.scenario_id === scenarioId) || { scenario_id: scenarioId, active: 0, completed: 0, goal_reached: 0, total: 0 };

  if (!user) return null;

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            DMシナリオ管理
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            自動DM配信シナリオの作成・管理・監視
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={processQueue}
            disabled={processing}
            className="btn-primary px-4 py-2 text-sm rounded-lg disabled:opacity-50"
          >
            {processing ? '処理中...' : 'キュー処理実行'}
          </button>
          <button
            onClick={() => setEditingScenario({
              scenario_name: '',
              trigger_type: 'thankyou_first',
              trigger_config: {},
              segment_targets: [],
              steps: [{ step: 0, delay_hours: 0, template: 'thankyou', message: '{username}さん、ありがとう!', use_persona: true }],
              is_active: false,
              auto_approve_step0: true,
              daily_send_limit: 50,
              min_interval_hours: 24,
            })}
            className="btn-primary px-4 py-2 text-sm rounded-lg"
          >
            + 新規シナリオ
          </button>
        </div>
      </div>

      {processResult && (
        <div className="glass-panel p-3 text-sm" style={{ color: 'var(--accent-green)' }}>
          {processResult}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b" style={{ borderColor: 'var(--border-glass)' }}>
        <button
          onClick={() => setTab('list')}
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'list' ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          シナリオ一覧 ({scenarios.length})
        </button>
        <button
          onClick={() => setTab('enrollments')}
          className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'enrollments' ? 'border-sky-400 text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          エンロールメント監視
        </button>
      </div>

      {/* Scenario List Tab */}
      {tab === 'list' && (
        <div className="space-y-4">
          {loading ? (
            <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>
          ) : scenarios.length === 0 ? (
            <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              シナリオがありません。「+ 新規シナリオ」から作成してください。
            </div>
          ) : (
            <div className="grid gap-4">
              {scenarios.map(s => {
                const stats = getStats(s.id);
                return (
                  <div key={s.id} className="glass-card p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                            {s.scenario_name || '(名前なし)'}
                          </h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            s.is_active ? 'bg-green-500/20 text-green-400' : 'bg-slate-500/20 text-slate-400'
                          }`}>
                            {s.is_active ? '有効' : '無効'}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-400">
                            {getTriggerLabel(s.trigger_type)}
                          </span>
                        </div>

                        {/* Steps summary */}
                        <div className="flex gap-4 text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
                          <span>{(s.steps || []).length}ステップ</span>
                          <span>上限: {s.daily_send_limit}件/日</span>
                          <span>間隔: {s.min_interval_hours}h</span>
                          {s.auto_approve_step0 && <span className="text-amber-400">自動承認</span>}
                          {s.segment_targets?.length > 0 && (
                            <span>対象: {s.segment_targets.join(', ')}</span>
                          )}
                        </div>

                        {/* Steps detail */}
                        <div className="space-y-1 mb-3">
                          {(s.steps || []).map((step, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-sky-500/20 text-sky-400">
                                {i + 1}
                              </span>
                              <span className="w-16">{step.delay_hours}h後</span>
                              <span className="flex-1 truncate">{step.message || step.template || '-'}</span>
                              {step.use_persona !== false && (
                                <span className="text-purple-400 text-[10px]">AI</span>
                              )}
                            </div>
                          ))}
                        </div>

                        {/* Enrollment stats */}
                        <div className="flex gap-4 text-xs">
                          <span style={{ color: 'var(--accent-primary)' }}>
                            進行中: {stats.active}
                          </span>
                          <span style={{ color: 'var(--accent-green)' }}>
                            完了: {stats.completed}
                          </span>
                          <span style={{ color: 'var(--accent-amber)' }}>
                            ゴール達成: {stats.goal_reached}
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>
                            合計: {stats.total}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-2 ml-4">
                        <button
                          onClick={() => toggleActive(s.id, s.is_active)}
                          className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                            s.is_active
                              ? 'bg-slate-500/20 text-slate-400 hover:bg-slate-500/30'
                              : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                          }`}
                        >
                          {s.is_active ? '無効にする' : '有効にする'}
                        </button>
                        <button
                          onClick={() => setEditingScenario({ ...s })}
                          className="text-xs px-3 py-1.5 rounded-lg bg-sky-500/20 text-sky-400 hover:bg-sky-500/30"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => previewAiMessage(s)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                        >
                          {previewLoading ? '生成中...' : 'AI文面プレビュー'}
                        </button>
                        <button
                          onClick={() => {
                            setSelectedScenario(s);
                            fetchEnrollments(s.id);
                            setTab('enrollments');
                          }}
                          className="text-xs px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                        >
                          進捗確認
                        </button>
                        <button
                          onClick={() => deleteScenario(s.id)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500/30"
                        >
                          削除
                        </button>
                      </div>
                    </div>

                    {/* Preview */}
                    {previewMsg && (
                      <div className="mt-3 glass-panel p-3">
                        <p className="text-[10px] font-bold mb-1" style={{ color: 'var(--accent-purple)' }}>AI文面プレビュー:</p>
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{previewMsg}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Enrollments Tab */}
      {tab === 'enrollments' && (
        <div className="space-y-4">
          {/* Scenario selector */}
          <div className="glass-card p-4">
            <label className="text-xs font-bold mb-2 block" style={{ color: 'var(--text-secondary)' }}>
              シナリオを選択:
            </label>
            <div className="flex flex-wrap gap-2">
              {scenarios.map(s => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSelectedScenario(s);
                    fetchEnrollments(s.id);
                  }}
                  className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                    selectedScenario?.id === s.id
                      ? 'bg-sky-500/30 text-sky-300'
                      : 'bg-white/5 text-slate-400 hover:bg-white/10'
                  }`}
                >
                  {s.scenario_name || s.trigger_type} ({getStats(s.id).active} active)
                </button>
              ))}
            </div>
          </div>

          {/* Selected scenario enrollments */}
          {selectedScenario ? (
            <div className="glass-card p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                  {selectedScenario.scenario_name} のエンロールメント
                </h3>
                <div className="flex gap-3 text-xs">
                  {(() => {
                    const stats = getStats(selectedScenario.id);
                    const goalRate = stats.total > 0 ? Math.round((stats.goal_reached / stats.total) * 100) : 0;
                    return (
                      <>
                        <span style={{ color: 'var(--accent-primary)' }}>進行中: {stats.active}</span>
                        <span style={{ color: 'var(--accent-green)' }}>完了: {stats.completed}</span>
                        <span style={{ color: 'var(--accent-amber)' }}>ゴール: {stats.goal_reached} ({goalRate}%)</span>
                      </>
                    );
                  })()}
                </div>
              </div>

              {enrollments.length === 0 ? (
                <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  エンロールメントがありません
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th className="text-left p-2">ユーザー</th>
                        <th className="text-left p-2">キャスト</th>
                        <th className="text-center p-2">ステップ</th>
                        <th className="text-center p-2">状態</th>
                        <th className="text-left p-2">次回送信</th>
                        <th className="text-left p-2">最終送信</th>
                        <th className="text-left p-2">ゴール</th>
                        <th className="text-left p-2">作成日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrollments.map(e => {
                        const isStuck = e.status === 'active' && e.next_step_due_at &&
                          new Date(e.next_step_due_at).getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000;
                        return (
                          <tr key={e.id} className={`border-t ${isStuck ? 'bg-rose-500/5' : ''}`}
                            style={{ borderColor: 'var(--border-glass)' }}
                          >
                            <td className="p-2 font-medium" style={{ color: 'var(--text-primary)' }}>
                              {e.username}
                            </td>
                            <td className="p-2" style={{ color: 'var(--text-secondary)' }}>
                              {e.cast_name || '-'}
                            </td>
                            <td className="p-2 text-center">
                              <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400">
                                {e.current_step + 1}/{(selectedScenario.steps || []).length}
                              </span>
                            </td>
                            <td className="p-2 text-center">
                              <span className={`px-2 py-0.5 rounded-full ${
                                e.status === 'active' ? 'bg-blue-500/20 text-blue-400' :
                                e.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                                e.status === 'goal_reached' ? 'bg-amber-500/20 text-amber-400' :
                                'bg-slate-500/20 text-slate-400'
                              }`}>
                                {e.status === 'active' ? '進行中' :
                                 e.status === 'completed' ? '完了' :
                                 e.status === 'goal_reached' ? 'ゴール' : e.status}
                              </span>
                              {isStuck && (
                                <span className="ml-1 text-rose-400 text-[10px]">滞留</span>
                              )}
                            </td>
                            <td className="p-2" style={{ color: isStuck ? 'var(--accent-pink)' : 'var(--text-secondary)' }}>
                              {formatDate(e.next_step_due_at)}
                            </td>
                            <td className="p-2" style={{ color: 'var(--text-secondary)' }}>
                              {formatDate(e.last_step_sent_at)}
                            </td>
                            <td className="p-2" style={{ color: e.goal_reached_at ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                              {e.goal_type || '-'}
                              {e.goal_reached_at && ' ✓'}
                            </td>
                            <td className="p-2" style={{ color: 'var(--text-muted)' }}>
                              {formatDate(e.created_at)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="glass-card p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              シナリオを選択してエンロールメントを表示
            </div>
          )}
        </div>
      )}

      {/* Edit/Create Modal */}
      {editingScenario && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setEditingScenario(null)}
        >
          <div
            className="glass-card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
              {editingScenario.id ? 'シナリオ編集' : '新規シナリオ作成'}
            </h2>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: 'var(--text-secondary)' }}>シナリオ名</label>
                <input
                  className="input-glass w-full text-sm"
                  value={editingScenario.scenario_name || ''}
                  onChange={e => setEditingScenario({ ...editingScenario, scenario_name: e.target.value })}
                  placeholder="例: 初課金お礼DM"
                />
              </div>

              {/* Trigger Type */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: 'var(--text-secondary)' }}>トリガータイプ</label>
                <select
                  className="input-glass w-full text-sm"
                  value={editingScenario.trigger_type || 'manual'}
                  onChange={e => setEditingScenario({ ...editingScenario, trigger_type: e.target.value })}
                >
                  {TRIGGER_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              {/* Segment Targets */}
              <div>
                <label className="text-xs font-bold block mb-1" style={{ color: 'var(--text-secondary)' }}>対象セグメント (空=全セグメント)</label>
                <div className="flex flex-wrap gap-2">
                  {SEGMENTS.map(seg => {
                    const selected = (editingScenario.segment_targets || []).includes(seg);
                    return (
                      <button
                        key={seg}
                        onClick={() => {
                          const current = editingScenario.segment_targets || [];
                          setEditingScenario({
                            ...editingScenario,
                            segment_targets: selected ? current.filter(s => s !== seg) : [...current, seg],
                          });
                        }}
                        className={`text-xs px-2 py-1 rounded transition-colors ${
                          selected ? 'bg-sky-500/30 text-sky-300' : 'bg-white/5 text-slate-400 hover:bg-white/10'
                        }`}
                      >
                        {seg}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Settings row */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: 'var(--text-secondary)' }}>日次上限</label>
                  <input
                    type="number"
                    className="input-glass w-full text-sm"
                    value={editingScenario.daily_send_limit || 50}
                    onChange={e => setEditingScenario({ ...editingScenario, daily_send_limit: parseInt(e.target.value) || 50 })}
                  />
                </div>
                <div>
                  <label className="text-xs font-bold block mb-1" style={{ color: 'var(--text-secondary)' }}>最小間隔(h)</label>
                  <input
                    type="number"
                    className="input-glass w-full text-sm"
                    value={editingScenario.min_interval_hours || 24}
                    onChange={e => setEditingScenario({ ...editingScenario, min_interval_hours: parseInt(e.target.value) || 24 })}
                  />
                </div>
                <div className="flex items-end gap-4">
                  <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={editingScenario.auto_approve_step0 ?? true}
                      onChange={e => setEditingScenario({ ...editingScenario, auto_approve_step0: e.target.checked })}
                    />
                    Step1自動承認
                  </label>
                </div>
              </div>

              {/* Steps */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>ステップ</label>
                  <button
                    onClick={() => {
                      const steps = [...(editingScenario.steps || [])];
                      steps.push({
                        step: steps.length,
                        delay_hours: 24,
                        template: '',
                        message: '',
                        use_persona: true,
                      });
                      setEditingScenario({ ...editingScenario, steps });
                    }}
                    className="text-xs px-2 py-1 rounded bg-sky-500/20 text-sky-400 hover:bg-sky-500/30"
                  >
                    + ステップ追加
                  </button>
                </div>

                <div className="space-y-3">
                  {(editingScenario.steps || []).map((step, i) => (
                    <div key={i} className="glass-panel p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold" style={{ color: 'var(--accent-primary)' }}>
                          Step {i + 1}
                        </span>
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <input
                              type="checkbox"
                              checked={step.use_persona !== false}
                              onChange={e => {
                                const steps = [...(editingScenario.steps || [])];
                                steps[i] = { ...steps[i], use_persona: e.target.checked };
                                setEditingScenario({ ...editingScenario, steps });
                              }}
                            />
                            AI生成
                          </label>
                          {(editingScenario.steps || []).length > 1 && (
                            <button
                              onClick={() => {
                                const steps = (editingScenario.steps || []).filter((_, j) => j !== i);
                                setEditingScenario({ ...editingScenario, steps });
                              }}
                              className="text-rose-400 text-xs hover:text-rose-300"
                            >
                              削除
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>遅延時間</label>
                          <input
                            type="number"
                            className="input-glass w-full text-sm"
                            value={step.delay_hours}
                            onChange={e => {
                              const steps = [...(editingScenario.steps || [])];
                              steps[i] = { ...steps[i], delay_hours: parseInt(e.target.value) || 0 };
                              setEditingScenario({ ...editingScenario, steps });
                            }}
                            placeholder="時間"
                          />
                        </div>
                        <div>
                          <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ゴール</label>
                          <select
                            className="input-glass w-full text-sm"
                            value={step.goal || ''}
                            onChange={e => {
                              const steps = [...(editingScenario.steps || [])];
                              steps[i] = { ...steps[i], goal: e.target.value || undefined };
                              setEditingScenario({ ...editingScenario, steps });
                            }}
                          >
                            <option value="">なし</option>
                            <option value="reply">返信</option>
                            <option value="visit">来訪</option>
                            <option value="payment">課金</option>
                            <option value="reply_or_visit">返信 or 来訪</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          メッセージテンプレート (AI生成時はフォールバック用。{'{username}'} で置換)
                        </label>
                        <textarea
                          className="input-glass w-full text-sm"
                          rows={2}
                          value={step.message || ''}
                          onChange={e => {
                            const steps = [...(editingScenario.steps || [])];
                            steps[i] = { ...steps[i], message: e.target.value };
                            setEditingScenario({ ...editingScenario, steps });
                          }}
                          placeholder="{username}さん、ありがとう!"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Save/Cancel */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => setEditingScenario(null)}
                  className="btn-ghost px-4 py-2 text-sm rounded-lg"
                >
                  キャンセル
                </button>
                <button
                  onClick={saveScenario}
                  className="btn-primary px-4 py-2 text-sm rounded-lg"
                  disabled={!editingScenario.scenario_name}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
