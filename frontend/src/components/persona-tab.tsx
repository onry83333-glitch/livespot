'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { CastPersona } from '@/types';

/* ============================================================
   Constants
   ============================================================ */
const CHARACTER_TYPES = ['甘え系', '甘え系×聞き上手', 'クール系', '元気系', '元気系×ノリツッコミ', 'お姉さん系', 'ミステリアス系'];
const EMOJI_RATES = [
  { value: 'low', label: '控えめ' },
  { value: 'medium', label: '普通' },
  { value: 'high', label: '多め' },
] as const;
const FORMALITY_LEVELS = [
  { value: 'casual', label: 'カジュアル' },
  { value: 'casual_polite', label: 'カジュアル丁寧' },
  { value: 'polite', label: '丁寧語' },
] as const;

const DEFAULT_PERSONA: Omit<CastPersona, 'id' | 'account_id' | 'created_at' | 'updated_at'> = {
  cast_name: '',
  character_type: '甘え系',
  speaking_style: { suffix: ['〜', 'よ', 'ね'], emoji_rate: 'medium', formality: 'casual_polite', max_length: 120 },
  personality_traits: ['聞き上手'],
  ng_behaviors: ['他キャストの悪口', 'お金の話を直接する'],
  greeting_patterns: { first_time: 'はじめまして！', regular: 'おかえり〜', vip: '○○さん待ってた！' },
  dm_tone_examples: { thankyou: '今日はありがとう〜', churn: '最近見かけないけど元気？' },
};

/* ============================================================
   Props
   ============================================================ */
interface PersonaTabProps {
  castName: string;
  accountId: string;
}

/* ============================================================
   Component
   ============================================================ */
export function PersonaTab({ castName, accountId }: PersonaTabProps) {
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [persona, setPersona] = useState<CastPersona | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Form state
  const [characterType, setCharacterType] = useState(DEFAULT_PERSONA.character_type);
  const [suffixText, setSuffixText] = useState(DEFAULT_PERSONA.speaking_style.suffix.join('、'));
  const [emojiRate, setEmojiRate] = useState<'low' | 'medium' | 'high'>(DEFAULT_PERSONA.speaking_style.emoji_rate);
  const [formality, setFormality] = useState<'casual' | 'casual_polite' | 'polite'>(DEFAULT_PERSONA.speaking_style.formality);
  const [maxLength, setMaxLength] = useState(DEFAULT_PERSONA.speaking_style.max_length);
  const [traitsText, setTraitsText] = useState(DEFAULT_PERSONA.personality_traits.join('、'));
  const [ngText, setNgText] = useState(DEFAULT_PERSONA.ng_behaviors.join('\n'));
  const [greetFirst, setGreetFirst] = useState(DEFAULT_PERSONA.greeting_patterns.first_time);
  const [greetRegular, setGreetRegular] = useState(DEFAULT_PERSONA.greeting_patterns.regular);
  const [greetVip, setGreetVip] = useState(DEFAULT_PERSONA.greeting_patterns.vip);
  const [toneThankyou, setToneThankyou] = useState(DEFAULT_PERSONA.dm_tone_examples.thankyou);
  const [toneChurn, setToneChurn] = useState(DEFAULT_PERSONA.dm_tone_examples.churn);

  // Preview (legacy DM-only preview)
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  // Engine task_type switching
  type EngineTaskType = 'dm' | 'x_post' | 'content';
  const [engineTask, setEngineTask] = useState<EngineTaskType>('dm');
  const [engineGenerating, setEngineGenerating] = useState(false);
  const [engineResult, setEngineResult] = useState<Record<string, unknown> | null>(null);
  const [engineRawText, setEngineRawText] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Load persona
  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    sb.from('cast_persona')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .single()
      .then(({ data }) => {
        if (data) {
          const p = data as CastPersona;
          setPersona(p);
          setCharacterType(p.character_type);
          setSuffixText(p.speaking_style.suffix.join('、'));
          setEmojiRate(p.speaking_style.emoji_rate);
          setFormality(p.speaking_style.formality);
          setMaxLength(p.speaking_style.max_length);
          setTraitsText(p.personality_traits.join('、'));
          setNgText(p.ng_behaviors.join('\n'));
          setGreetFirst(p.greeting_patterns.first_time || '');
          setGreetRegular(p.greeting_patterns.regular || '');
          setGreetVip(p.greeting_patterns.vip || '');
          setToneThankyou(p.dm_tone_examples.thankyou || '');
          setToneChurn(p.dm_tone_examples.churn || '');
        }
        setLoading(false);
      });
  }, [accountId, castName, sb]);

  // Build persona data from form
  const buildPersonaData = useCallback(() => {
    return {
      account_id: accountId,
      cast_name: castName,
      character_type: characterType,
      speaking_style: {
        suffix: suffixText.split(/[、,]/).map(s => s.trim()).filter(Boolean),
        emoji_rate: emojiRate,
        formality,
        max_length: maxLength,
      },
      personality_traits: traitsText.split(/[、,]/).map(s => s.trim()).filter(Boolean),
      ng_behaviors: ngText.split('\n').map(s => s.trim()).filter(Boolean),
      greeting_patterns: { first_time: greetFirst, regular: greetRegular, vip: greetVip },
      dm_tone_examples: { thankyou: toneThankyou, churn: toneChurn },
      updated_at: new Date().toISOString(),
    };
  }, [accountId, castName, characterType, suffixText, emojiRate, formality, maxLength, traitsText, ngText, greetFirst, greetRegular, greetVip, toneThankyou, toneChurn]);

  // Save
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg('');
    const data = buildPersonaData();

    if (persona) {
      const { error } = await sb.from('cast_persona').update(data).eq('id', persona.id);
      if (error) {
        setSaveMsg(`エラー: ${error.message}`);
      } else {
        setSaveMsg('保存しました');
      }
    } else {
      const { data: inserted, error } = await sb.from('cast_persona').insert(data).select().single();
      if (error) {
        setSaveMsg(`エラー: ${error.message}`);
      } else {
        setPersona(inserted as CastPersona);
        setSaveMsg('新規作成しました');
      }
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(''), 3000);
  }, [persona, buildPersonaData, sb]);

  // Preview
  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        setPreviewResult('認証エラー: ログインし直してください');
        setPreviewing(false);
        return;
      }
      const res = await fetch('/api/persona', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          task_type: 'dm_generate',
          cast_name: castName,
          context: {
            user_name: 'preview_user',
            cast_name: castName,
            scenario_type: 'thankyou_regular',
            step_number: 1,
          },
        }),
      });
      const result = await res.json();
      if (result.error) {
        setPreviewResult(`エラー: ${result.error}`);
      } else {
        const output = typeof result.output === 'object' && result.output?.message
          ? result.output.message
          : result.raw_text;
        setPreviewResult(`${output}\n\n--- メタ情報 ---\nトークン: ${result.cost_tokens}\nコスト: $${result.cost_usd?.toFixed(4) || '?'}\nペルソナ: ${result.persona_found ? '登録済み' : 'デフォルト'}`);
      }
    } catch (e) {
      setPreviewResult(`通信エラー: ${(e as Error).message}`);
    }
    setPreviewing(false);
  }, [castName, sb]);

  // Engine generation
  const handleEngineGenerate = useCallback(async () => {
    setEngineGenerating(true);
    setEngineResult(null);
    setEngineRawText(null);
    setEngineError(null);
    setFeedbackMsg(null);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setEngineError('認証エラー'); setEngineGenerating(false); return; }

      const contextMap: Record<EngineTaskType, Record<string, unknown>> = {
        dm: { user_name: 'preview_user', cast_name: castName, scenario_type: 'thankyou_regular', step_number: 1 },
        x_post: { cast_name: castName, mood: '日常' },
        content: { cast_name: castName, content_type: 'caption' },
      };

      const res = await fetch('/api/persona/engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ task_type: engineTask, cast_name: castName, account_id: accountId, context: contextMap[engineTask] }),
      });
      const json = await res.json();
      if (json.error) { setEngineError(json.error); } else {
        setEngineResult(typeof json.output === 'object' ? json.output : { raw: json.output });
        setEngineRawText(json.raw_text || null);
      }
    } catch (e) { setEngineError((e as Error).message); }
    setEngineGenerating(false);
  }, [engineTask, castName, accountId, sb]);

  // Feedback submission
  const handleFeedback = useCallback(async (isGood: boolean) => {
    if (!engineRawText && !engineResult) return;
    setFeedbackSending(true);
    setFeedbackMsg(null);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { setFeedbackMsg('認証エラー'); setFeedbackSending(false); return; }
      const outputStr = engineRawText || JSON.stringify(engineResult);
      const res = await fetch('/api/persona/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          cast_name: castName,
          task_type: engineTask,
          output: outputStr,
          score: isGood ? 90 : 30,
          score_source: 'manual',
          account_id: accountId,
          metadata: { source: 'persona_tab_preview' },
        }),
      });
      const json = await res.json();
      if (json.error) { setFeedbackMsg(`エラー: ${json.error}`); } else { setFeedbackMsg(isGood ? '高評価を記録しました' : '低評価を記録しました'); }
    } catch (e) { setFeedbackMsg((e as Error).message); }
    setFeedbackSending(false);
    setTimeout(() => setFeedbackMsg(null), 3000);
  }, [engineRawText, engineResult, castName, engineTask, accountId, sb]);

  if (loading) {
    return <div className="text-center py-8 text-xs" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold flex items-center gap-2">
            ペルソナ設定
            <span className="text-[10px] px-2 py-0.5 rounded-lg"
              style={{ background: persona ? 'rgba(34,197,94,0.1)' : 'rgba(251,191,36,0.1)', color: persona ? '#22c55e' : '#fbbf24' }}>
              {persona ? '登録済み' : '未登録（デフォルト使用中）'}
            </span>
          </h3>
          <div className="flex items-center gap-2">
            {saveMsg && (
              <span className="text-[10px] px-2 py-0.5 rounded-lg"
                style={{ background: saveMsg.startsWith('エラー') ? 'rgba(244,63,94,0.1)' : 'rgba(34,197,94,0.1)', color: saveMsg.startsWith('エラー') ? '#f43f5e' : '#22c55e' }}>
                {saveMsg}
              </span>
            )}
            <button onClick={handleSave} disabled={saving}
              className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', color: 'white' }}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>

        {/* Character Type */}
        <div className="mb-3">
          <label className="text-[10px] font-semibold uppercase tracking-wider block mb-1" style={{ color: 'var(--text-muted)' }}>
            キャラクタータイプ
          </label>
          <div className="flex flex-wrap gap-1.5">
            {CHARACTER_TYPES.map(t => (
              <button key={t} onClick={() => setCharacterType(t)}
                className="text-[11px] px-3 py-1 rounded-lg transition-all"
                style={{
                  background: characterType === t ? 'rgba(56,189,248,0.15)' : 'rgba(15,23,42,0.4)',
                  color: characterType === t ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  border: characterType === t ? '1px solid rgba(56,189,248,0.3)' : '1px solid var(--border-glass)',
                }}>
                {t}
              </button>
            ))}
            <input type="text" value={characterType} onChange={e => setCharacterType(e.target.value)}
              className="text-[11px] px-2 py-1 rounded-lg w-32"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}
              placeholder="カスタム入力" />
          </div>
        </div>
      </div>

      {/* Speaking Style */}
      <div className="glass-card p-4">
        <h4 className="text-[11px] font-bold mb-3">口調設定</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>語尾（カンマ区切り）</label>
            <input type="text" value={suffixText} onChange={e => setSuffixText(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}
              placeholder="〜、よ、ね" />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>最大文字数</label>
            <input type="number" value={maxLength} onChange={e => setMaxLength(Number(e.target.value))}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>絵文字使用率</label>
            <div className="flex gap-1.5">
              {EMOJI_RATES.map(r => (
                <button key={r.value} onClick={() => setEmojiRate(r.value)}
                  className="text-[11px] px-3 py-1 rounded-lg flex-1 transition-all"
                  style={{
                    background: emojiRate === r.value ? 'rgba(56,189,248,0.15)' : 'rgba(15,23,42,0.4)',
                    color: emojiRate === r.value ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    border: emojiRate === r.value ? '1px solid rgba(56,189,248,0.3)' : '1px solid var(--border-glass)',
                  }}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>敬語レベル</label>
            <div className="flex gap-1.5">
              {FORMALITY_LEVELS.map(f => (
                <button key={f.value} onClick={() => setFormality(f.value)}
                  className="text-[11px] px-3 py-1 rounded-lg flex-1 transition-all"
                  style={{
                    background: formality === f.value ? 'rgba(56,189,248,0.15)' : 'rgba(15,23,42,0.4)',
                    color: formality === f.value ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    border: formality === f.value ? '1px solid rgba(56,189,248,0.3)' : '1px solid var(--border-glass)',
                  }}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Personality & NG */}
      <div className="glass-card p-4">
        <h4 className="text-[11px] font-bold mb-3">性格 & NG行動</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>性格特徴（カンマ区切り）</label>
            <input type="text" value={traitsText} onChange={e => setTraitsText(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}
              placeholder="照れ屋、聞き上手、感謝を素直に言える" />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>NG行動（1行1項目）</label>
            <textarea value={ngText} onChange={e => setNgText(e.target.value)} rows={3}
              className="w-full text-xs px-3 py-2 rounded-lg resize-none"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}
              placeholder="他キャストの悪口&#10;お金の話を直接する" />
          </div>
        </div>
      </div>

      {/* Greeting Patterns */}
      <div className="glass-card p-4">
        <h4 className="text-[11px] font-bold mb-3">挨拶パターン</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>初回</label>
            <input type="text" value={greetFirst} onChange={e => setGreetFirst(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>常連</label>
            <input type="text" value={greetRegular} onChange={e => setGreetRegular(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>VIP</label>
            <input type="text" value={greetVip} onChange={e => setGreetVip(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
        </div>
      </div>

      {/* DM Tone Examples */}
      <div className="glass-card p-4">
        <h4 className="text-[11px] font-bold mb-3">DMトーンのお手本</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>お礼DM</label>
            <textarea value={toneThankyou} onChange={e => setToneThankyou(e.target.value)} rows={2}
              className="w-full text-xs px-3 py-2 rounded-lg resize-none"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
          <div>
            <label className="text-[10px] font-semibold block mb-1" style={{ color: 'var(--text-muted)' }}>離脱防止DM</label>
            <textarea value={toneChurn} onChange={e => setToneChurn(e.target.value)} rows={2}
              className="w-full text-xs px-3 py-2 rounded-lg resize-none"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }} />
          </div>
        </div>
      </div>

      {/* AI生成テスト */}
      <div className="glass-card p-4">
        <h4 className="text-[11px] font-bold mb-3">AI生成テスト</h4>
        <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>
          ペルソナ設定を使ってAIコンテンツを生成します。生成後にフィードバックすると精度が向上します。
        </p>

        {/* Task type selector */}
        <div className="flex gap-1.5 mb-4">
          {([
            { key: 'dm' as const, icon: '💬', label: 'DM生成' },
            { key: 'x_post' as const, icon: '𝕏', label: 'X投稿' },
            { key: 'content' as const, icon: '📄', label: 'コンテンツ' },
          ]).map(t => (
            <button key={t.key} onClick={() => { setEngineTask(t.key); setEngineResult(null); setEngineRawText(null); setEngineError(null); setFeedbackMsg(null); }}
              className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all flex-1"
              style={{
                background: engineTask === t.key ? 'rgba(168,85,247,0.15)' : 'rgba(15,23,42,0.4)',
                color: engineTask === t.key ? '#a855f7' : 'var(--text-secondary)',
                border: engineTask === t.key ? '1px solid rgba(168,85,247,0.3)' : '1px solid var(--border-glass)',
              }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Generate button */}
        <button onClick={handleEngineGenerate} disabled={engineGenerating}
          className="w-full text-[11px] px-3 py-2 rounded-lg font-semibold transition-all disabled:opacity-50 mb-3"
          style={{ background: 'linear-gradient(135deg, rgba(168,85,247,0.2), rgba(56,189,248,0.2))', color: '#a855f7', border: '1px solid rgba(168,85,247,0.3)' }}>
          {engineGenerating ? '生成中...' : `${engineTask === 'dm' ? 'DM文面' : engineTask === 'x_post' ? 'X投稿' : 'コンテンツ'}を生成`}
        </button>

        {/* Error */}
        {engineError && (
          <div className="p-3 rounded-lg text-xs mb-3"
            style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.3)', color: '#f43f5e' }}>
            {engineError}
          </div>
        )}

        {/* Result */}
        {engineResult && !engineGenerating && (
          <div className="space-y-2">
            <div className="p-3 rounded-lg text-xs whitespace-pre-wrap"
              style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)' }}>
              {engineTask === 'dm' && typeof engineResult.message === 'string' && (
                <div>
                  <p className="font-semibold mb-1" style={{ color: 'var(--accent-purple)' }}>DM文面:</p>
                  <p>{engineResult.message}</p>
                </div>
              )}
              {engineTask === 'x_post' && typeof engineResult.post_text === 'string' && (
                <div>
                  <p className="font-semibold mb-1" style={{ color: 'var(--accent-primary)' }}>投稿文:</p>
                  <p>{engineResult.post_text}</p>
                  {Array.isArray(engineResult.hashtags) && (
                    <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {(engineResult.hashtags as string[]).join(' ')}
                    </p>
                  )}
                </div>
              )}
              {engineTask === 'content' && typeof engineResult.content === 'string' && (
                <div>
                  <p className="font-semibold mb-1" style={{ color: 'var(--accent-green)' }}>コンテンツ:</p>
                  <p>{engineResult.content}</p>
                </div>
              )}
              {typeof engineResult.message !== 'string' && typeof engineResult.post_text !== 'string' && typeof engineResult.content !== 'string' && typeof engineResult.raw === 'string' && (
                <p>{engineResult.raw}</p>
              )}
              {typeof engineResult.reasoning === 'string' && (
                <p className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  理由: {engineResult.reasoning}
                </p>
              )}
            </div>

            {/* Feedback buttons */}
            <div className="flex items-center gap-2">
              <button onClick={() => handleFeedback(true)} disabled={feedbackSending}
                className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-50"
                style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                ✅ 良い
              </button>
              <button onClick={() => handleFeedback(false)} disabled={feedbackSending}
                className="text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all disabled:opacity-50"
                style={{ background: 'rgba(244,63,94,0.1)', color: '#f43f5e', border: '1px solid rgba(244,63,94,0.3)' }}>
                ❌ 改善が必要
              </button>
              {feedbackMsg && (
                <span className="text-[10px] px-2 py-0.5 rounded-lg"
                  style={{ background: feedbackMsg.startsWith('エラー') ? 'rgba(244,63,94,0.1)' : 'rgba(34,197,94,0.1)', color: feedbackMsg.startsWith('エラー') ? '#f43f5e' : '#22c55e' }}>
                  {feedbackMsg}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
