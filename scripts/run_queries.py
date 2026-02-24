"""
Supabase PostgREST API経由でhanshakun DM用セグメント抽出クエリを実行
"""
import os, urllib.request, json
from datetime import datetime, timedelta, timezone
from collections import defaultdict

JST = timezone(timedelta(hours=9))
SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co'
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

def api_get(path):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        'apikey': SERVICE_KEY,
        'Authorization': f'Bearer {SERVICE_KEY}',
        'Accept': 'application/json',
    }
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read().decode())

# --- Fetch data ---
print("Fetching coin_transactions for hanshakun...")
txs = api_get("coin_transactions?cast_name=eq.hanshakun&select=user_name,date,tokens&limit=1000&order=date.desc")
print(f"  -> {len(txs)} transactions")

print("Fetching paid_users for hanshakun...")
pus = api_get("paid_users?cast_name=eq.hanshakun&select=user_name,segment,last_payment_date&limit=5000")
print(f"  -> {len(pus)} paid_users")

# Build paid_users lookup
pu_map = {p['user_name']: p for p in pus}

# --- Aggregate by user_name ---
user_agg = defaultdict(lambda: {'dates': [], 'total_coins': 0, 'tx_count': 0})
for tx in txs:
    u = tx['user_name']
    user_agg[u]['dates'].append(tx['date'])
    user_agg[u]['total_coins'] += (tx['tokens'] or 0)
    user_agg[u]['tx_count'] += 1

# Parse dates and compute first/last
for u, data in user_agg.items():
    dates = []
    for d in data['dates']:
        try:
            if d:
                dt = datetime.fromisoformat(d.replace('Z', '+00:00'))
                dates.append(dt)
        except:
            pass
    data['first_paid_at'] = min(dates) if dates else None
    data['last_paid_at'] = max(dates) if dates else None

now = datetime.now(timezone.utc)

# ============================================================
# Query A: 直近初課金ユーザー (first_paid_at >= 2026-02-19 JST)
# ============================================================
print("\n" + "="*80)
print("【抽出A】直近初課金ユーザー（2026-02-19以降に初課金）")
print("="*80)
cutoff_a = datetime(2026, 2, 19, 0, 0, 0, tzinfo=JST)
results_a = []
for u, data in user_agg.items():
    if data['first_paid_at'] and data['first_paid_at'] >= cutoff_a:
        pu = pu_map.get(u, {})
        results_a.append({
            'user_name': u,
            'first_paid_at': data['first_paid_at'].astimezone(JST).strftime('%Y-%m-%d %H:%M'),
            'last_paid_at': data['last_paid_at'].astimezone(JST).strftime('%Y-%m-%d %H:%M') if data['last_paid_at'] else '-',
            'total_coins': data['total_coins'],
            'tx_count': data['tx_count'],
            'segment': pu.get('segment', 'N/A'),
            'last_payment_date': pu.get('last_payment_date', '-'),
        })
results_a.sort(key=lambda x: x['total_coins'], reverse=True)

print(f"\n{'user_name':<25} {'first_paid':<18} {'last_paid':<18} {'coins':>8} {'tx':>4} {'segment':<12}")
print("-"*90)
for r in results_a:
    print(f"{r['user_name']:<25} {r['first_paid_at']:<18} {r['last_paid_at']:<18} {r['total_coins']:>8} {r['tx_count']:>4} {r['segment']:<12}")
print(f"\n合計: {len(results_a)}名")

# ============================================================
# Query B: 9月組セグメント分布
# ============================================================
print("\n" + "="*80)
print("【抽出B】9月組セグメント分布（2025-09-01 ~ 2026-02-14 初課金）")
print("="*80)
cutoff_b_start = datetime(2025, 9, 1, 0, 0, 0, tzinfo=JST)
cutoff_b_end = datetime(2026, 2, 15, 0, 0, 0, tzinfo=JST)

def get_recency(last_paid):
    if not last_paid:
        return 'Dormant'
    days = (now - last_paid).days
    if days <= 30:
        return 'Active'
    elif days <= 60:
        return 'Recent'
    elif days <= 90:
        return 'AtRisk'
    else:
        return 'Dormant'

seg_recency = defaultdict(lambda: {'user_count': 0, 'total_coins': 0})
for u, data in user_agg.items():
    if data['first_paid_at'] and cutoff_b_start <= data['first_paid_at'] < cutoff_b_end:
        pu = pu_map.get(u, {})
        segment = pu.get('segment', 'N/A')
        recency = get_recency(data['last_paid_at'])
        key = (segment, recency)
        seg_recency[key]['user_count'] += 1
        seg_recency[key]['total_coins'] += data['total_coins']

results_b = [{'segment': k[0], 'recency': k[1], **v} for k, v in seg_recency.items()]
results_b.sort(key=lambda x: x['total_coins'], reverse=True)

print(f"\n{'segment':<12} {'recency':<10} {'users':>6} {'total_coins':>12}")
print("-"*45)
for r in results_b:
    print(f"{r['segment']:<12} {r['recency']:<10} {r['user_count']:>6} {r['total_coins']:>12}")
total_users_b = sum(r['user_count'] for r in results_b)
total_coins_b = sum(r['total_coins'] for r in results_b)
print(f"{'TOTAL':<12} {'':<10} {total_users_b:>6} {total_coins_b:>12}")

# ============================================================
# Query B-2: 9月組個別リスト（VIP以上 or 直近Active）
# ============================================================
print("\n" + "="*80)
print("【抽出B-2】9月組個別リスト（coins>=3000 or Active）")
print("="*80)
results_b2 = []
for u, data in user_agg.items():
    if data['first_paid_at'] and cutoff_b_start <= data['first_paid_at'] < cutoff_b_end:
        is_active = data['last_paid_at'] and (now - data['last_paid_at']).days <= 30
        if data['total_coins'] >= 3000 or is_active:
            pu = pu_map.get(u, {})
            results_b2.append({
                'user_name': u,
                'segment': pu.get('segment', 'N/A'),
                'total_coins': data['total_coins'],
                'first_paid_at': data['first_paid_at'].astimezone(JST).strftime('%Y-%m-%d'),
                'last_paid_at': data['last_paid_at'].astimezone(JST).strftime('%Y-%m-%d') if data['last_paid_at'] else '-',
                'status': 'Active' if is_active else 'Dormant',
            })
results_b2.sort(key=lambda x: x['total_coins'], reverse=True)

print(f"\n{'user_name':<25} {'segment':<12} {'coins':>8} {'first_paid':<12} {'last_paid':<12} {'status':<8}")
print("-"*82)
for r in results_b2:
    print(f"{r['user_name']:<25} {r['segment']:<12} {r['total_coins']:>8} {r['first_paid_at']:<12} {r['last_paid_at']:<12} {r['status']:<8}")
print(f"\n合計: {len(results_b2)}名")
print(f"  Active: {sum(1 for r in results_b2 if r['status']=='Active')}名")
print(f"  Dormant: {sum(1 for r in results_b2 if r['status']=='Dormant')}名")
