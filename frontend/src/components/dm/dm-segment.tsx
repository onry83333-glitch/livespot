'use client';

import { useState } from 'react';
import DmSegmentSender from '@/components/dm-segment-sender';
import DmSegmentRfm from '@/components/dm/dm-segment-rfm';
import type { DMLogItem, SB } from '@/types/dm';

interface DmSegmentProps {
  accountId: string;
  castName: string;
  sb: SB;
  setDmLogs: (logs: DMLogItem[]) => void;
}

type SegTab = 'golden' | 'rfm';

export default function DmSegment({ accountId, castName, sb, setDmLogs }: DmSegmentProps) {
  const [tab, setTab] = useState<SegTab>('golden');

  const refreshLogs = () => {
    sb.from('dm_send_log')
      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
      .eq('account_id', accountId).eq('cast_name', castName)
      .order('created_at', { ascending: false }).limit(200)
      .then(({ data }) => setDmLogs((data || []) as DMLogItem[]));
  };

  return (
    <div className="space-y-3">
      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
        {([
          { key: 'golden' as SegTab, label: '🎯 黄金比セグメント' },
          { key: 'rfm' as SegTab, label: '📐 RFM分析' },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="flex-1 text-[11px] font-medium py-1.5 rounded-md transition-colors"
            style={{
              background: tab === t.key ? 'rgba(56,189,248,0.15)' : 'transparent',
              color: tab === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
              border: tab === t.key ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'golden' ? (
        <DmSegmentSender
          supabase={sb}
          accountId={accountId}
          castName={castName}
          onSendComplete={refreshLogs}
        />
      ) : (
        <DmSegmentRfm
          accountId={accountId}
          castName={castName}
          sb={sb}
        />
      )}
    </div>
  );
}
