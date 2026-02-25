# -*- coding: utf-8 -*-
"""
Risa_06 リテンションDM用ターゲットリスト抽出
Step 1-5 を一括実行
"""
import os, urllib.request, json, csv, sys
from datetime import datetime, timedelta, timezone
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

JST = timezone(timedelta(hours=9))
SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co'
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

def api_get_all(path, limit=1000):
    all_data = []
    offset = 0
    while True:
        sep = '&' if '?' in path else '?'
        url = f"{SUPABASE_URL}/rest/v1/{path}{sep}limit={limit}&offset={offset}"
        headers = {'apikey': SERVICE_KEY, 'Authorization': f'Bearer {SERVICE_KEY}', 'Accept': 'application/json', 'Prefer': 'count=exact'}
        req = urllib.request.Request(url, headers=headers)
        resp = urllib.request.urlopen(req)
        cr = resp.headers.get('Content-Range', '')
        data = json.loads(resp.read().decode())
        all_data.extend(data)
        if len(data) < limit:
            break
        offset += limit
    return all_data

def parse_date(d):
    if not d: return None
    try: return datetime.fromisoformat(d.replace('Z', '+00:00'))
    except: return None

def fmt_date(d):
    dt = parse_date(d) if isinstance(d, str) else d
    if not dt: return '-'
    return dt.astimezone(JST).strftime('%Y-%m-%d')

now = datetime.now(timezone.utc)
cutoff = datetime(2025, 11, 15, 0, 0, 0, tzinfo=JST)

# ============================================================
# Step 0: データ確認 — 月別集計
# ============================================================
print("=" * 80)
print("Step 0: Risa_06 coin_transactions データ確認")
print("=" * 80)

# Check total count first
import urllib.parse
date_filter = urllib.parse.quote('2025-11-14T15:00:00+00:00')  # 11/15 00:00 JST = 11/14 15:00 UTC

print("\nFetching coin_transactions for Risa_06 (since 2025-11-15 JST)...")
txs = api_get_all(f"coin_transactions?cast_name=eq.Risa_06&date=gte.{date_filter}&select=user_name,date,tokens&order=date.asc")
print(f"  -> {len(txs)} transactions")

if len(txs) == 0:
    # Also check with paid_users
    print("\ncoin_transactions が 0件。paid_users を確認...")
    pus = api_get_all("paid_users?cast_name=eq.Risa_06&select=user_name,total_coins,last_payment_date,first_payment_date&order=total_coins.desc&limit=10")
    print(f"  paid_users for Risa_06: {len(pus)} 件")
    if pus:
        print("\n  Top 5:")
        for p in pus[:5]:
            print(f"    {p['user_name']:<25} {p.get('total_coins',0):>7}tk  first={fmt_date(p.get('first_payment_date'))}  last={fmt_date(p.get('last_payment_date'))}")

    # Check all cast names to see if spelling is different
    print("\n  全キャスト名を確認:")
    all_casts = api_get_all("coin_transactions?select=cast_name&limit=1000")
    cast_names = sorted(set(t.get('cast_name','') for t in all_casts if t.get('cast_name')))
    for c in cast_names:
        print(f"    - {c}")

    # Also check paid_users cast names
    print("\n  paid_users 全キャスト名:")
    all_pu_casts = api_get_all("paid_users?select=cast_name&limit=5000")
    pu_cast_names = sorted(set(p.get('cast_name','') for p in all_pu_casts if p.get('cast_name')))
    for c in pu_cast_names:
        print(f"    - {c}")

    print("\n⚠️ coin_transactions が 0件のため、paid_users ベースで抽出します。")

    # Use paid_users instead
    print("\n\nFetching all paid_users for Risa_06...")
    all_risa = api_get_all("paid_users?cast_name=eq.Risa_06&select=user_name,total_coins,last_payment_date,first_payment_date,segment,tx_count")
    print(f"  -> {len(all_risa)} paid_users")

    if len(all_risa) == 0:
        print("\n❌ Risa_06 のデータが paid_users にも存在しません。")
        print("   cast_name のスペルを確認してください。")
        sys.exit(0)

    # Filter: first_payment_date >= 2025-11-15 OR last_payment_date >= 2025-11-15
    filtered = []
    for pu in all_risa:
        lp = parse_date(pu.get('last_payment_date'))
        fp = parse_date(pu.get('first_payment_date'))
        if (lp and lp >= cutoff) or (fp and fp >= cutoff):
            filtered.append(pu)

    print(f"\n11/15以降にアクティブなユーザー: {len(filtered)}名")
    print(f"  総coins: {sum(p.get('total_coins',0) for p in filtered)}")

    # Step 1: 300tk以上
    step1 = [p for p in filtered if (p.get('total_coins') or 0) >= 300]
    print(f"\n【Step 1】300tk以上: {len(step1)}名")
    print(f"  総coins: {sum(p.get('total_coins',0) for p in step1)}")
    print(f"  平均coins: {round(sum(p.get('total_coins',0) for p in step1)/len(step1)) if step1 else 0}")

    # Step 2: tx_count >= 2
    step2 = [p for p in step1 if (p.get('tx_count') or 0) >= 2]
    excluded = len(step1) - len(step2)
    print(f"\n【Step 2】2回以上リピート: {len(step2)}名 (除外: {excluded}名)")

    # Step 3: Whale分離
    whales = [p for p in step2 if (p.get('total_coins') or 0) >= 5000]
    dm_targets = [p for p in step2 if (p.get('total_coins') or 0) < 5000]
    print(f"\n【Step 3】ホエール分離")
    print(f"  ホエール (5000tk+): {len(whales)}名")
    for w in sorted(whales, key=lambda x: x.get('total_coins',0), reverse=True):
        print(f"    {w['user_name']:<25} {w.get('total_coins',0):>7}tk  seg={w.get('segment','?')}  last={fmt_date(w.get('last_payment_date'))}")
    print(f"  DM対象 (<5000tk): {len(dm_targets)}名")

    # Step 4: paid_usersベースではサブセグメント不可（月別tx明細なし）
    print(f"\n【Step 4】⚠️ coin_transactionsがないため月別サブセグメント分割不可")
    print(f"  paid_users.last_payment_date ベースで代替分類:")

    for p in dm_targets:
        lp = parse_date(p.get('last_payment_date'))
        if lp and lp >= datetime(2026, 2, 1, tzinfo=JST):
            p['sub_segment'] = 'C (2月〜直近)'
        elif lp and lp >= datetime(2026, 1, 1, tzinfo=JST):
            p['sub_segment'] = 'B (1月)'
        else:
            p['sub_segment'] = 'A (〜12月)'

    from collections import Counter
    seg_counts = Counter(p['sub_segment'] for p in dm_targets)
    for seg in ['A (〜12月)', 'B (1月)', 'C (2月〜直近)']:
        members = [p for p in dm_targets if p['sub_segment'] == seg]
        if members:
            avg = round(sum(p.get('total_coins',0) for p in members)/len(members))
            last_dates = [parse_date(p.get('last_payment_date')) for p in members if parse_date(p.get('last_payment_date'))]
            latest = fmt_date(max(last_dates)) if last_dates else '-'
            print(f"  {seg}: {len(members)}名  avg={avg}tk  最終={latest}")

    # Step 5: CSV出力
    dm_targets.sort(key=lambda x: (
        0 if x.get('sub_segment','').startswith('C') else 1 if x.get('sub_segment','').startswith('B') else 2,
        -(x.get('total_coins') or 0)
    ))

    print(f"\n【Step 5】最終リスト")
    print(f"{'user_name':<25} {'coins':>7} {'tx':>4} {'last_paid':<12} {'segment':<10} {'sub_seg':<16} {'priority'}")
    print("-" * 95)

    priority_map = {'C (2月〜直近)': '★★★', 'B (1月)': '★★', 'A (〜12月)': '★'}
    for p in dm_targets:
        pri = priority_map.get(p.get('sub_segment',''), '?')
        print(f"{p['user_name']:<25} {p.get('total_coins',0):>7} {p.get('tx_count','-'):>4} {fmt_date(p.get('last_payment_date')):<12} {p.get('segment','?'):<10} {p.get('sub_segment','?'):<16} {pri}")

    csv_path = 'C:/dev/livespot/scripts/dm_risa06_retention.csv'
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['user_name', 'total_coins', 'tx_count', 'last_payment_date', 'segment', 'sub_segment', 'priority'])
        for p in dm_targets:
            pri = priority_map.get(p.get('sub_segment',''), '?')
            writer.writerow([
                p['user_name'], p.get('total_coins',0), p.get('tx_count',''),
                fmt_date(p.get('last_payment_date')), p.get('segment',''),
                p.get('sub_segment',''), pri
            ])
    print(f"\nCSV出力: {csv_path} ({len(dm_targets)}名)")

    # Whale CSV
    whale_csv = 'C:/dev/livespot/scripts/dm_risa06_whales.csv'
    with open(whale_csv, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['user_name', 'total_coins', 'tx_count', 'last_payment_date', 'segment'])
        for w in sorted(whales, key=lambda x: x.get('total_coins',0), reverse=True):
            writer.writerow([w['user_name'], w.get('total_coins',0), w.get('tx_count',''), fmt_date(w.get('last_payment_date')), w.get('segment','')])
    print(f"Whale CSV: {whale_csv} ({len(whales)}名)")
    sys.exit(0)

# --- If we DO have coin_transactions, use them ---
print(f"\n月別集計:")
monthly = defaultdict(lambda: {'tx_count': 0, 'users': set(), 'total_coins': 0})
for tx in txs:
    dt = parse_date(tx['date'])
    if dt:
        month_key = dt.astimezone(JST).strftime('%Y-%m')
        monthly[month_key]['tx_count'] += 1
        monthly[month_key]['users'].add(tx['user_name'])
        monthly[month_key]['total_coins'] += (tx['tokens'] or 0)

print(f"{'month':<10} {'tx_count':>8} {'users':>8} {'total_coins':>12}")
print("-" * 42)
for m in sorted(monthly.keys()):
    d = monthly[m]
    print(f"{m:<10} {d['tx_count']:>8} {len(d['users']):>8} {d['total_coins']:>12}")

# Step 1: Aggregate per user, filter >= 300tk
user_agg = defaultdict(lambda: {'total_coins': 0, 'tx_count': 0, 'dates': [], 'monthly': defaultdict(int)})
for tx in txs:
    u = tx['user_name']
    tokens = tx['tokens'] or 0
    dt = parse_date(tx['date'])
    user_agg[u]['total_coins'] += tokens
    user_agg[u]['tx_count'] += 1
    if dt:
        user_agg[u]['dates'].append(dt)
        month_key = dt.astimezone(JST).strftime('%Y-%m')
        user_agg[u]['monthly'][month_key] += tokens

step1 = {u: d for u, d in user_agg.items() if d['total_coins'] >= 300}
print(f"\n{'='*80}")
print(f"【Step 1】300tk以上: {len(step1)}名")
print(f"  総coins: {sum(d['total_coins'] for d in step1.values())}")
print(f"  平均coins: {round(sum(d['total_coins'] for d in step1.values())/len(step1)) if step1 else 0}")

# Step 2: tx_count >= 2
step2 = {u: d for u, d in step1.items() if d['tx_count'] >= 2}
excluded = len(step1) - len(step2)
print(f"\n【Step 2】2回以上リピート: {len(step2)}名 (除外: {excluded}名)")

# Step 3: Whale separation
whales = {u: d for u, d in step2.items() if d['total_coins'] >= 5000}
dm_targets = {u: d for u, d in step2.items() if d['total_coins'] < 5000}
print(f"\n【Step 3】ホエール分離")
print(f"  ホエール (5000tk+): {len(whales)}名")
for u in sorted(whales.keys(), key=lambda x: whales[x]['total_coins'], reverse=True):
    d = whales[u]
    last = fmt_date(max(d['dates'])) if d['dates'] else '-'
    print(f"    {u:<25} {d['total_coins']:>7}tk  tx={d['tx_count']}  last={last}")
print(f"  DM対象 (<5000tk): {len(dm_targets)}名")

# Step 4: Sub-segment by peak month
print(f"\n【Step 4】サブセグメント分け")
results = []
for u, d in dm_targets.items():
    # Determine sub-segment by which period had most coins
    period_a = sum(v for k, v in d['monthly'].items() if '2025-11' <= k <= '2025-12')  # 11/15-12/31
    period_b = sum(v for k, v in d['monthly'].items() if k == '2026-01')  # 1月
    period_c = sum(v for k, v in d['monthly'].items() if k >= '2026-02')  # 2月〜

    if period_c >= period_b and period_c >= period_a:
        sub = 'C (2月〜直近)'
    elif period_b >= period_a:
        sub = 'B (1月)'
    else:
        sub = 'A (11-12月)'

    last_date = max(d['dates']) if d['dates'] else None
    results.append({
        'user_name': u,
        'total_coins': d['total_coins'],
        'tx_count': d['tx_count'],
        'last_date': last_date,
        'sub_segment': sub,
        'period_a': period_a,
        'period_b': period_b,
        'period_c': period_c,
    })

# Sub-segment summary
for seg in ['C (2月〜直近)', 'B (1月)', 'A (11-12月)']:
    members = [r for r in results if r['sub_segment'] == seg]
    if members:
        avg = round(sum(r['total_coins'] for r in members)/len(members))
        last_dates = [r['last_date'] for r in members if r['last_date']]
        latest = fmt_date(max(last_dates)) if last_dates else '-'
        print(f"  {seg}: {len(members)}名  avg={avg}tk  最終={latest}")

# Step 5: Final output
priority_map = {'C (2月〜直近)': '★★★', 'B (1月)': '★★', 'A (11-12月)': '★'}
results.sort(key=lambda x: (
    0 if x['sub_segment'].startswith('C') else 1 if x['sub_segment'].startswith('B') else 2,
    -x['total_coins']
))

print(f"\n{'='*80}")
print(f"【Step 5】最終リスト ({len(results)}名)")
print(f"{'='*80}")
print(f"{'user_name':<25} {'coins':>7} {'tx':>4} {'last_date':<12} {'sub_seg':<16} {'pri'}")
print("-" * 75)
for r in results:
    pri = priority_map.get(r['sub_segment'], '?')
    print(f"{r['user_name']:<25} {r['total_coins']:>7} {r['tx_count']:>4} {fmt_date(r['last_date']):<12} {r['sub_segment']:<16} {pri}")

# CSV
csv_path = 'C:/dev/livespot/scripts/dm_risa06_retention.csv'
with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['user_name', 'total_coins', 'tx_count', 'last_payment_date', 'sub_segment', 'priority'])
    for r in results:
        pri = priority_map.get(r['sub_segment'], '?')
        writer.writerow([r['user_name'], r['total_coins'], r['tx_count'], fmt_date(r['last_date']), r['sub_segment'], pri])
print(f"\nCSV出力: {csv_path} ({len(results)}名)")

whale_csv = 'C:/dev/livespot/scripts/dm_risa06_whales.csv'
with open(whale_csv, 'w', encoding='utf-8-sig', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['user_name', 'total_coins', 'tx_count', 'last_payment_date'])
    for u in sorted(whales.keys(), key=lambda x: whales[x]['total_coins'], reverse=True):
        d = whales[u]
        last = fmt_date(max(d['dates'])) if d['dates'] else '-'
        writer.writerow([u, d['total_coins'], d['tx_count'], last])
print(f"Whale CSV: {whale_csv} ({len(whales)}名)")
