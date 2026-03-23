'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getTodayStartJST } from '@/lib/utils';
import type { SpyMessage } from '@/types';

import LiveStatusBar from '@/components/live/LiveStatusBar';
import LiveUserFeed, { type LiveUser, type UserCategory } from '@/components/live/LiveUserFeed';
import LiveCoinUsers from '@/components/live/LiveCoinUsers';
import { useRealtimeCoinUsers } from '@/components/live/hooks/useRealtimeCoinUsers';
import LiveDMRetention from '@/components/live/LiveDMRetention';
import LiveManagerPanel from '@/components/live/LiveManagerPanel';
import LiveSessionSummary from '@/components/live/LiveSessionSummary';
import { useLiveSession } from '@/components/live/hooks/useLiveSession';
import { useRealtimeSpyLive } from '@/components/live/hooks/useRealtimeSpy';
import { useRealtimeViewers } from '@/components/live/hooks/useRealtimeViewers';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

// ---- Cached user data for classification ----
interface CachedUserData {
  firstSeen: string | null;      // earliest spy_messages record
  lastSeen: string | null;       // most recent spy_messages record
  firstPaidDate: string | null;  // earliest coin_transactions
  totalTip: number;              // cumulative tokens for this cast
  category: UserCategory;
  daysSince: number | null;
}

export default function LivePage() {
  const { castName } = useParams<{ castName: string }>();
  const decodedCastName = decodeURIComponent(castName);

  // Core session data
  const session = useLiveSession(decodedCastName);

  // Coin users (live_viewer_stats Realtime)
  const coinUsers = useRealtimeCoinUsers({ castName: decodedCastName });

  // User cache (userName -> CachedUserData)
  const userCacheRef = useRef<Map<string, CachedUserData>>(new Map());
  const [liveUsers, setLiveUsers] = useState<LiveUser[]>([]);

  // DM retention
  const [dmSentUsers, setDmSentUsers] = useState<Set<string>>(new Set());
  const [dmVisitedUsers, setDmVisitedUsers] = useState<string[]>([]);

  // Counters
  const [newUserCount, setNewUserCount] = useState(0);
  const [returnUserCount, setReturnUserCount] = useState(0);

  // Supabase ref
  const supabase = useRef(createClient());

  // ---- Initial data load ----
  useEffect(() => {
    const load = async () => {
      const sb = supabase.current;
      const todayStart = getTodayStartJST().toISOString();

      // Pre-load coin_transactions history for this cast (all time)
      const { data: coinData } = await sb
        .from('coin_transactions')
        .select('user_name, tokens, transaction_date')
        .eq('cast_name', decodedCastName)
        .eq('account_id', ACCOUNT_ID)
        .gte('transaction_date', '2025-02-15')
        .order('transaction_date', { ascending: true });

      if (coinData) {
        for (const row of coinData) {
          if (!row.user_name) continue;
          const existing = userCacheRef.current.get(row.user_name);
          if (existing) {
            existing.totalTip += row.tokens || 0;
            if (!existing.firstPaidDate || row.transaction_date < existing.firstPaidDate) {
              existing.firstPaidDate = row.transaction_date;
            }
          } else {
            userCacheRef.current.set(row.user_name, {
              firstSeen: null,
              lastSeen: null,
              firstPaidDate: row.transaction_date,
              totalTip: row.tokens || 0,
              category: 'new',
              daysSince: null,
            });
          }
        }
      }

      // Pre-load recent spy_messages to detect existing user visit history
      const { data: spyData } = await sb
        .from('chat_logs')
        .select('username, timestamp')
        .eq('cast_name', decodedCastName)
        .eq('account_id', ACCOUNT_ID)
        .gte('timestamp', '2025-02-15')
        .lt('timestamp', todayStart)
        .order('timestamp', { ascending: true })
        .limit(5000);

      if (spyData) {
        for (const row of spyData) {
          if (!row.username) continue;
          const existing = userCacheRef.current.get(row.username);
          if (existing) {
            if (!existing.firstSeen || row.timestamp < existing.firstSeen) {
              existing.firstSeen = row.timestamp;
            }
            if (!existing.lastSeen || row.timestamp > existing.lastSeen) {
              existing.lastSeen = row.timestamp;
            }
          } else {
            userCacheRef.current.set(row.username, {
              firstSeen: row.timestamp,
              lastSeen: row.timestamp,
              firstPaidDate: null,
              totalTip: 0,
              category: 'new',
              daysSince: null,
            });
          }
        }
      }

      // Load DM send log (last 48h)
      const dmCutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { data: dmData } = await sb
        .from('dm_send_log')
        .select('user_name')
        .eq('cast_name', decodedCastName)
        .eq('status', 'success')
        .gte('sent_at', dmCutoff);

      if (dmData) {
        setDmSentUsers(new Set(dmData.map((d) => d.user_name)));
      }
    };

    load();
  }, [decodedCastName]);

  // ---- Classify a user ----
  const classifyUser = useCallback(
    async (userName: string, league: string | null, level: number | null, messageTime: string): Promise<LiveUser | null> => {
      // Already displayed in this session? Skip
      if (liveUsers.some((u) => u.userName === userName)) return null;

      let cached = userCacheRef.current.get(userName);

      // If not in cache, query DB
      if (!cached) {
        const sb = supabase.current;

        const [spyRes, coinRes] = await Promise.all([
          sb
            .from('chat_logs')
            .select('timestamp')
            .eq('cast_name', decodedCastName)
            .eq('account_id', ACCOUNT_ID)
            .eq('username', userName)
            .gte('timestamp', '2025-02-15')
            .order('timestamp', { ascending: true })
            .limit(1),
          sb
            .from('coin_transactions')
            .select('tokens, transaction_date')
            .eq('cast_name', decodedCastName)
            .eq('account_id', ACCOUNT_ID)
            .eq('user_name', userName)
            .gte('transaction_date', '2025-02-15'),
        ]);

        const firstSeen = spyRes.data?.[0]?.timestamp ?? null;
        const totalTip = coinRes.data?.reduce((s, r) => s + (r.tokens || 0), 0) ?? 0;
        const firstPaid = coinRes.data?.length
          ? coinRes.data.reduce((min, r) => (r.transaction_date < min ? r.transaction_date : min), coinRes.data[0].transaction_date)
          : null;

        cached = {
          firstSeen,
          lastSeen: firstSeen,
          firstPaidDate: firstPaid,
          totalTip,
          category: 'new',
          daysSince: null,
        };
        userCacheRef.current.set(userName, cached);
      }

      // Classification
      const now = new Date();
      let category: UserCategory = 'new';
      let daysSince: number | null = null;

      if (cached.lastSeen) {
        const lastDate = new Date(cached.lastSeen);
        daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysSince <= 7) {
          category = 'repeater';
        } else {
          category = 'return';
        }
      }
      // No previous records -> new

      cached.category = category;
      cached.daysSince = daysSince;

      return {
        userName,
        category,
        daysSince,
        firstPaidDate: cached.firstPaidDate,
        totalTip: cached.totalTip,
        enteredAt: messageTime,
        league,
        level,
      };
    },
    [decodedCastName, liveUsers]
  );

  // ---- Handle new spy message ----
  const seenUsersRef = useRef<Set<string>>(new Set());

  const handleNewMessage = useCallback(
    async (msg: SpyMessage) => {
      // Tip handling — update revenue counter + cache
      const isTip = msg.msg_type === 'tip' || msg.msg_type === 'gift';
      if (isTip && msg.tokens > 0) {
        const cached = userCacheRef.current.get(msg.user_name ?? '');
        if (cached) cached.totalTip += msg.tokens;
        session.addRevenue(msg.tokens);
      }

      // User detection (skip system messages and messages without username)
      if (!msg.user_name) return;
      if (msg.msg_type === 'system' || msg.msg_type === 'viewer_count') return;

      // Skip if already seen in this session
      if (seenUsersRef.current.has(msg.user_name)) return;
      seenUsersRef.current.add(msg.user_name);

      // Classify and add to feed
      const user = await classifyUser(
        msg.user_name,
        msg.user_league,
        msg.user_level,
        msg.message_time
      );

      if (user) {
        setLiveUsers((prev) => [...prev, user]);

        if (user.category === 'new') setNewUserCount((c) => c + 1);
        if (user.category === 'return') setReturnUserCount((c) => c + 1);

        // DM retention check
        if (dmSentUsers.has(user.userName)) {
          setDmVisitedUsers((prev) =>
            prev.includes(user.userName) ? prev : [...prev, user.userName]
          );
        }
      }
    },
    [classifyUser, session, dmSentUsers]
  );

  // ---- Realtime subscriptions ----
  const { isConnected: spyConnected } = useRealtimeSpyLive({
    castName: decodedCastName,
    onMessage: handleNewMessage,
  });

  useRealtimeViewers({
    castName: decodedCastName,
    onViewerUpdate: session.updateViewerCount,
  });

  return (
    <div
      className="flex flex-col h-screen"
      style={{ background: 'var(--bg-deep)', color: 'var(--text-primary)' }}
    >
      {/* A. Status Bar */}
      <LiveStatusBar
        isLive={session.isLive}
        elapsedSeconds={session.elapsedSeconds}
        viewerCount={session.viewerCount}
        todayRevenue={session.todayRevenue}
        isConnected={spyConnected}
      />

      {/* Main content: B + E + C */}
      <div className="flex flex-1 min-h-0">
        {/* Left 2/3: User Feed */}
        <div
          className="flex-[2] min-w-0"
          style={{ borderRight: '1px solid var(--border-glass)' }}
        >
          <LiveUserFeed users={liveUsers} />
        </div>

        {/* Right 1/3: Coin Users + DM Retention */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* E. Coin Users (top) */}
          <div className="flex-1 min-h-0" style={{ borderBottom: '1px solid var(--border-glass)' }}>
            <LiveCoinUsers latest={coinUsers.latest} history={coinUsers.history} />
          </div>

          {/* C. DM Retention (bottom) */}
          <div style={{ minHeight: '140px' }}>
            <LiveDMRetention
              dmSentCount={dmSentUsers.size}
              visitedUsers={dmVisitedUsers}
            />
          </div>
        </div>
      </div>

      {/* F. Manager Panel */}
      <div style={{ borderTop: '1px solid var(--border-glass)' }}>
        <LiveManagerPanel castName={decodedCastName} />
      </div>

      {/* G. Session Summary */}
      <LiveSessionSummary
        todayRevenue={session.todayRevenue}
        todayTipCount={session.todayTipCount}
        peakViewerCount={session.peakViewerCount}
        newUserCount={newUserCount}
        returnUserCount={returnUserCount}
      />
    </div>
  );
}
