"""
paid_users テーブルから直接セグメント抽出
coin_transactions ではなく paid_users を使用（全履歴集計済み）
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
        'Prefer': 'count=exact',
    }
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req)
    cr = resp.headers.get('Content-Range', '')
    data = json.loads(resp.read().decode())
    return data, cr

def parse_date(d):
    if not d:
        return None
    try:
        return datetime.fromisoformat(d.replace('Z', '+00:00'))
    except:
        return None

def fmt_date(dt, fmt='%Y-%m-%d'):
    if not dt:
        return '-'
    if isinstance(dt, str):
        dt = parse_date(dt)
    if not dt:
        return '-'
    return dt.astimezone(JST).strftime(fmt)

now = datetime.now(timezone.utc)

# Fetch ALL paid_users for hanshakun
print("Fetching paid_users for hanshakun...")
all_users = []
offset = 0
while True:
    batch, cr = api_get(
        f"paid_users?cast_name=eq.hanshakun"
        f"&select=user_name,total_coins,segment,first_payment_date,last_payment_date,tx_count"
        f"&order=total_coins.desc&limit=1000&offset={offset}"
    )
    all_users.extend(batch)
    if len(batch) < 1000:
        break
    offset += 1000

print(f"  -> {len(all_users)} paid_users")

# ============================================================
# Query A: 直近初課金ユーザー (first_payment_date >= 2026-02-19 JST)
# ============================================================
print("\n" + "="*90)
print("【抽出A】直近初課金ユーザー（2026-02-19以降に初課金）")
print("="*90)
cutoff_a = datetime(2026, 2, 19, 0, 0, 0, tzinfo=JST)
results_a = []
for u in all_users:
    fp = parse_date(u.get('first_payment_date'))
    if fp and fp >= cutoff_a:
        results_a.append(u)
results_a.sort(key=lambda x: x.get('total_coins', 0) or 0, reverse=True)

print(f"\n{'user_name':<28} {'first_payment':<14} {'last_payment':<14} {'coins':>8} {'tx':>5} {'segment':<10}")
print("-"*85)
for r in results_a:
    un = r['user_name']
    fp = fmt_date(r.get('first_payment_date'))
    lp = fmt_date(r.get('last_payment_date'))
    tc = r.get('total_coins') or 0
    txc = r.get('tx_count') or '-'
    seg = r.get('segment') or 'NULL'
    print(f"{un:<28} {fp:<14} {lp:<14} {tc:>8} {str(txc):>5} {seg:<10}")
print(f"\n合計: {len(results_a)}名, 総coins: {sum((r.get('total_coins') or 0) for r in results_a)}")

# ============================================================
# Query B: 9月組セグメント分布
# ============================================================
print("\n" + "="*90)
print("【抽出B】9月組セグメント分布（2025-09-01 ~ 2026-02-14 初課金）")
print("="*90)
cutoff_b_start = datetime(2025, 9, 1, 0, 0, 0, tzinfo=JST)
cutoff_b_end = datetime(2026, 2, 15, 0, 0, 0, tzinfo=JST)

seg_recency = defaultdict(lambda: {'user_count': 0, 'total_coins': 0})
for u in all_users:
    fp = parse_date(u.get('first_payment_date'))
    lp = parse_date(u.get('last_payment_date'))
    if fp and cutoff_b_start <= fp < cutoff_b_end:
        segment = u.get('segment') or 'NULL'
        if lp:
            days = (now - lp).days
            if days <= 30:
                recency = 'Active'
            elif days <= 60:
                recency = 'Recent'
            elif days <= 90:
                recency = 'AtRisk'
            else:
                recency = 'Dormant'
        else:
            recency = 'Dormant'
        key = (segment, recency)
        seg_recency[key]['user_count'] += 1
        seg_recency[key]['total_coins'] += (u.get('total_coins') or 0)

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
# Query B-2: 9月組個別リスト（coins>=3000 or Active）
# ============================================================
print("\n" + "="*90)
print("【抽出B-2】9月組個別リスト（coins>=3000 or 直近30日Active）")
print("="*90)
results_b2 = []
for u in all_users:
    fp = parse_date(u.get('first_payment_date'))
    lp = parse_date(u.get('last_payment_date'))
    if fp and cutoff_b_start <= fp < cutoff_b_end:
        tc = u.get('total_coins') or 0
        is_active = lp and (now - lp).days <= 30
        if tc >= 3000 or is_active:
            status = 'Active' if is_active else 'Dormant'
            results_b2.append({
                'user_name': u['user_name'],
                'segment': u.get('segment') or 'NULL',
                'total_coins': tc,
                'first_payment': fmt_date(u.get('first_payment_date')),
                'last_payment': fmt_date(u.get('last_payment_date')),
                'status': status,
            })
results_b2.sort(key=lambda x: x['total_coins'], reverse=True)

print(f"\n{'user_name':<28} {'segment':<10} {'coins':>8} {'first_paid':<12} {'last_paid':<12} {'status':<8}")
print("-"*82)
for r in results_b2:
    print(f"{r['user_name']:<28} {r['segment']:<10} {r['total_coins']:>8} {r['first_payment']:<12} {r['last_payment']:<12} {r['status']:<8}")
print(f"\n合計: {len(results_b2)}名")
print(f"  Active: {sum(1 for r in results_b2 if r['status']=='Active')}名")
print(f"  Dormant: {sum(1 for r in results_b2 if r['status']=='Dormant')}名")
total_b2_coins = sum(r['total_coins'] for r in results_b2)
print(f"  総coins: {total_b2_coins}")
