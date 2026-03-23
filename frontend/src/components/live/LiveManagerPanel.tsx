'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

interface Instruction {
  id: string;
  instruction_text: string;
  instruction_type: string;
  is_active: boolean;
  created_at: string;
}

interface LiveManagerPanelProps {
  castName: string;
}

const PRESETS = [
  { label: 'チケショ開始', text: 'チケショ開始してください' },
  { label: '価格変更', text: '価格変更お願いします' },
  { label: 'あと○分', text: 'あと10分で終了です' },
  { label: '休憩入れて', text: '一度休憩を入れてください' },
];

export default function LiveManagerPanel({ castName }: LiveManagerPanelProps) {
  const [inputText, setInputText] = useState('');
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [activeInstruction, setActiveInstruction] = useState<Instruction | null>(null);
  const [fadeOut, setFadeOut] = useState(false);
  const supabase = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabase.current.channel> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load existing instructions
  useEffect(() => {
    supabase.current
      .from('cast_live_instructions')
      .select('*')
      .eq('cast_name', castName)
      .eq('account_id', ACCOUNT_ID)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (data) {
          setInstructions(data);
          const active = data.find((d) => d.is_active);
          if (active) setActiveInstruction(active);
        }
      });
  }, [castName]);

  // Realtime subscription
  useEffect(() => {
    if (channelRef.current) return;

    const channel = supabase.current
      .channel(`live-instructions-${castName}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cast_live_instructions',
          filter: `cast_name=eq.${castName}`,
        },
        (payload) => {
          const row = payload.new as Instruction;
          if ((row as unknown as { account_id: string }).account_id !== ACCOUNT_ID) return;

          setInstructions((prev) => [row, ...prev].slice(0, 20));

          if (row.is_active) {
            setActiveInstruction(row);
            setFadeOut(false);

            // 3秒後にフェードアウト
            if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
            fadeTimerRef.current = setTimeout(() => {
              setFadeOut(true);
            }, 3000);
          }
        }
      );

    subscribeWithRetry(channel);
    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.current.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [castName]);

  const sendInstruction = useCallback(
    async (text: string, type = 'custom') => {
      if (!text.trim()) return;

      // Deactivate previous active instructions
      await supabase.current
        .from('cast_live_instructions')
        .update({ is_active: false })
        .eq('cast_name', castName)
        .eq('account_id', ACCOUNT_ID)
        .eq('is_active', true);

      // Insert new instruction
      await supabase.current.from('cast_live_instructions').insert({
        account_id: ACCOUNT_ID,
        cast_name: castName,
        instruction_type: type,
        instruction_text: text.trim(),
        is_active: true,
      });

      setInputText('');
    },
    [castName]
  );

  return (
    <div className="px-4 py-3">
      {/* Active instruction display */}
      {activeInstruction && !fadeOut && (
        <div
          className="mb-3 px-4 py-3 rounded-lg text-center anim-fade"
          style={{
            background: 'rgba(56,189,248,0.12)',
            border: '1px solid rgba(56,189,248,0.3)',
          }}
        >
          <span className="font-bold text-lg" style={{ color: 'var(--accent-primary)' }}>
            📢 {activeInstruction.instruction_text}
          </span>
        </div>
      )}

      {/* Preset buttons */}
      <div className="flex items-center gap-2 mb-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => sendInstruction(p.text, 'preset')}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:opacity-80"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-glass)',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Input field */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              sendInstruction(inputText);
            }
          }}
          placeholder="指示を入力..."
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-glass)',
          }}
        />
        <button
          onClick={() => sendInstruction(inputText)}
          disabled={!inputText.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-30"
          style={{
            background: 'var(--accent-primary)',
            color: '#000',
          }}
        >
          送信
        </button>
      </div>

      {/* Instruction history */}
      {instructions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {instructions.slice(0, 5).map((inst) => (
            <span
              key={inst.id}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: 'rgba(255,255,255,0.03)',
                color: 'var(--text-muted)',
              }}
            >
              {inst.instruction_text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
