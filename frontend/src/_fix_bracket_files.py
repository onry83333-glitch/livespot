#!/usr/bin/env python3
"""
Fix table and column references in bracket-path files.
spy_messages -> chat_logs, paid_users -> user_profiles
"""
import os

def fix_file(filepath, replacements, label):
    """Apply replacements to a file."""
    if not os.path.exists(filepath):
        print(f"  SKIP: {filepath} not found")
        return

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    changes = 0
    for old, new, desc in replacements:
        if old in content:
            content = content.replace(old, new)
            changes += 1
            print(f"  OK: [{label}] {desc}")
        else:
            print(f"  MISS: [{label}] {desc}")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    remaining_spy = content.count("from('spy_messages')")
    remaining_paid = content.count("from('paid_users')")
    remaining_rt = content.count("table: 'spy_messages'")
    print(f"  Remaining: spy_messages={remaining_spy}, paid_users={remaining_paid}, realtime={remaining_rt}")
    print(f"  Total changes: {changes}")
    print()

BASE = r'C:/dev/livespot/frontend/src/app'

# ============================================================
# 1. spy/[castName]/page.tsx — 4 spy_messages queries
# ============================================================
fix_file(
    f'{BASE}/spy/[castName]/page.tsx',
    [
        # Top tippers query
        (
            """    // Top tippers from spy_messages
    supabase.from('spy_messages')
      .select('user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('msg_type', ['tip', 'gift'])""",
            """    // Top tippers from chat_logs
    supabase.from('chat_logs')
      .select('username, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('message_type', ['tip', 'gift'])""",
            "Top tippers query"
        ),
        # Top tippers result processing
        (
            """          data.forEach(r => {
            if (r.user_name) tipMap.set(r.user_name, (tipMap.get(r.user_name) || 0) + (r.tokens || 0));
          });""",
            """          data.forEach(r => {
            const uname = r.username ?? r.user_name;
            if (uname) tipMap.set(uname, (tipMap.get(uname) || 0) + (r.tokens || 0));
          });""",
            "Top tippers result processing"
        ),
        # Recent messages query
        (
            """    // Recent messages
    supabase.from('spy_messages')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('message_time', { ascending: false })""",
            """    // Recent messages
    supabase.from('chat_logs')
      .select('*')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('timestamp', { ascending: false })""",
            "Recent messages query"
        ),
        # Session spy_messages aggregate query
        (
            """      const { data: msgs } = await supabase
        .from('spy_messages')
        .select('session_id, msg_type, user_name')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('session_id', sessionIds)
        .limit(50000);""",
            """      const { data: msgs } = await supabase
        .from('chat_logs')
        .select('session_id, message_type, username')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('session_id', sessionIds)
        .limit(50000);""",
            "Session aggregate query"
        ),
        # Session aggregate processing
        (
            """        if (m.msg_type === 'tip' || m.msg_type === 'gift') agg.tip_count++;
        if (m.user_name) agg.unique_users.add(m.user_name);""",
            """        if (m.message_type === 'tip' || m.message_type === 'gift') agg.tip_count++;
        const uname = m.username ?? m.user_name;
        if (uname) agg.unique_users.add(uname);""",
            "Session aggregate processing"
        ),
        # Ticket show tip query
        (
            """    let query = supabase.from('spy_messages')
      .select('message_time, user_name, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('message_time', since)
      .order('message_time', { ascending: true })
      .limit(50000);

    if (until) query = query.lte('message_time', until);

    query.then(async ({ data: tipData }) => {
      if (!tipData || tipData.length === 0) {
        setTicketShows([]); setTicketCVRs([]); setLoading(false); return;
      }
      const detected = detectTicketShows(tipData.map(t => ({ tokens: t.tokens, message_time: t.message_time, user_name: t.user_name || '' })));""",
            """    let query = supabase.from('chat_logs')
      .select('timestamp, username, tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('message_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .gte('timestamp', since)
      .order('timestamp', { ascending: true })
      .limit(50000);

    if (until) query = query.lte('timestamp', until);

    query.then(async ({ data: tipData }) => {
      if (!tipData || tipData.length === 0) {
        setTicketShows([]); setTicketCVRs([]); setLoading(false); return;
      }
      const detected = detectTicketShows(tipData.map(t => ({ tokens: t.tokens, message_time: t.timestamp, user_name: t.username || '' })));""",
            "Ticket show tip query"
        ),
    ],
    'spy/[castName]/page.tsx'
)

# ============================================================
# 2. casts/[castName]/page.tsx — 2 spy_messages + 1 paid_users
# ============================================================
fix_file(
    f'{BASE}/casts/[castName]/page.tsx',
    [
        # paid_users color cache
        (
            """    sb.from('paid_users')
      .select('user_name, total_coins')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('total_coins', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        const map = new Map<string, number>();
        (data || []).forEach((u: { user_name: string; total_coins: number }) => {
          map.set(u.user_name, u.total_coins);
        });
        setPaidUserCoins(map);
      });""",
            """    sb.from('user_profiles')
      .select('username, total_tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('total_tokens', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        const map = new Map<string, number>();
        (data || []).forEach((u: { username: string; total_tokens: number }) => {
          map.set(u.username, u.total_tokens);
        });
        setPaidUserCoins(map);
      });""",
            "paid_users color cache"
        ),
        # Session expand: load logs
        (
            """    const { data } = await sb.from('spy_messages')
      .select('*')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .gte('message_time', start)
      .lte('message_time', end)
      .order('message_time', { ascending: true })
      .limit(1000);""",
            """    const { data } = await sb.from('chat_logs')
      .select('*')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .gte('timestamp', start)
      .lte('timestamp', end)
      .order('timestamp', { ascending: true })
      .limit(1000);""",
            "Session expand load logs"
        ),
        # Analytics: last tips
        (
            """    // 最後のチップ（このキャストのspy_messages）
    sb.from('spy_messages')
      .select('user_name, tokens, message_time, message')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('msg_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .order('message_time', { ascending: false })
      .limit(5)
      .then(({ data }) => setLastTips((data || []) as typeof lastTips));""",
            """    // 最後のチップ（このキャストのchat_logs）
    sb.from('chat_logs')
      .select('username, tokens, timestamp, message')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .in('message_type', ['tip', 'gift'])
      .gt('tokens', 0)
      .order('timestamp', { ascending: false })
      .limit(5)
      .then(({ data }) => setLastTips((data || []).map(r => ({ user_name: r.username, tokens: r.tokens, message_time: r.timestamp, message: r.message })) as typeof lastTips));""",
            "Analytics last tips"
        ),
    ],
    'casts/[castName]/page.tsx'
)

# ============================================================
# 3. casts/[castName]/sessions/page.tsx — 1 spy_messages query
# ============================================================
fix_file(
    f'{BASE}/casts/[castName]/sessions/page.tsx',
    [
        (
            """    const { data: rawData } = await sb
      .from('spy_messages')
      .select('session_id, cast_name, session_title, message_time, user_name, tokens')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .not('session_id', 'is', null)
      .order('message_time', { ascending: false })
      .limit(5000);""",
            """    const { data: rawData } = await sb
      .from('chat_logs')
      .select('session_id, cast_name, session_title, timestamp, username, tokens')
      .eq('account_id', accountId!)
      .eq('cast_name', castName)
      .not('session_id', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(5000);""",
            "Fallback spy_messages query"
        ),
    ],
    'casts/[castName]/sessions/page.tsx'
)

# Need to also update the property access on rawData results
# Let me check what properties are accessed
fix_file(
    f'{BASE}/casts/[castName]/sessions/page.tsx',
    [
        # The rawData loop accesses r.session_id, r.cast_name, r.session_title (same)
        # and r.message_time, r.user_name, r.tokens -- need to check
    ],
    'casts/[castName]/sessions/page.tsx (property access check)'
)

# ============================================================
# 4. spy/users/[username]/page.tsx — 1 spy_messages query
# ============================================================
fix_file(
    f'{BASE}/spy/users/[username]/page.tsx',
    [
        (
            """      const { data: msgs } = await supabase
        .from('spy_messages')
        .select('*')
        .eq('account_id', data.id)
        .eq('user_name', username)
        .order('message_time', { ascending: false })
        .limit(50);""",
            """      const { data: rawMsgs } = await supabase
        .from('chat_logs')
        .select('*')
        .eq('account_id', data.id)
        .eq('username', username)
        .order('timestamp', { ascending: false })
        .limit(50);
      const msgs = (rawMsgs || []).map((r: Record<string, unknown>) => ({ ...r, message_time: r.timestamp ?? r.message_time, msg_type: r.message_type ?? r.msg_type, user_name: r.username ?? r.user_name }));""",
            "User messages query"
        ),
    ],
    'spy/users/[username]/page.tsx'
)

print("=== DONE ===")
