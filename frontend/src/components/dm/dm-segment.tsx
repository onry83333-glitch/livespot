'use client';

import DmSegmentSender from '@/components/dm-segment-sender';
import type { DMLogItem, SB } from '@/types/dm';

interface DmSegmentProps {
  accountId: string;
  castName: string;
  sb: SB;
  setDmLogs: (logs: DMLogItem[]) => void;
}

export default function DmSegment({ accountId, castName, sb, setDmLogs }: DmSegmentProps) {
  return (
    <DmSegmentSender
      supabase={sb}
      accountId={accountId}
      castName={castName}
      onSendComplete={() => {
        // DM送信完了後にログ再取得
        sb.from('dm_send_log')
          .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
          .eq('account_id', accountId).eq('cast_name', castName)
          .order('created_at', { ascending: false }).limit(200)
          .then(({ data }) => setDmLogs((data || []) as DMLogItem[]));
      }}
    />
  );
}
