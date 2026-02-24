# -*- coding: utf-8 -*-
"""
DM未送信ユーザーリスト抽出
dm_campaigns テーブルは存在しないため、dm_send_log.campaign カラムを直接使用
"""
import os, urllib.request, json, csv, io, sys
from datetime import datetime, timedelta, timezone
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')

JST = timezone(timedelta(hours=9))
SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co'
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

def api_get_all(path, limit=1000):
    """Paginated fetch"""
    all_data = []
    offset = 0
    while True:
        sep = '&' if '?' in path else '?'
        url = f"{SUPABASE_URL}/rest/v1/{path}{sep}limit={limit}&offset={offset}"
        headers = {
            'apikey': SERVICE_KEY,
            'Authorization': f'Bearer {SERVICE_KEY}',
            'Accept': 'application/json',
        }
        req = urllib.request.Request(url, headers=headers)
        resp = urllib.request.urlopen(req)
        data = json.loads(resp.read().decode())
        all_data.extend(data)
        if len(data) < limit:
            break
        offset += limit
    return all_data

def api_get_count(path):
    sep = '&' if '?' in path else '?'
    url = f"{SUPABASE_URL}/rest/v1/{path}{sep}limit=1"
    headers = {
        'apikey': SERVICE_KEY,
        'Authorization': f'Bearer {SERVICE_KEY}',
        'Accept': 'application/json',
        'Prefer': 'count=exact',
    }
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req)
    cr = resp.headers.get('Content-Range', '')
    return int(cr.split('/')[-1]) if '/' in cr else 0

def parse_date(d):
    if not d:
        return None
    try:
        return datetime.fromisoformat(d.replace('Z', '+00:00'))
    except:
        return None

def fmt_date(d):
    dt = parse_date(d) if isinstance(d, str) else d
    if not dt:
        return '-'
    return dt.astimezone(JST).strftime('%Y-%m-%d')

now = datetime.now(timezone.utc)

# ============================================================
# Step 0: Find pipe5 campaign names
# ============================================================
print("=" * 90)
print("Step 0: pipe5キャンペーン名の確認")
print("=" * 90)

# Fetch all dm_send_log with pipe5 campaigns
import urllib.parse
pipe5_logs = api_get_all(
    f"dm_send_log?campaign=like.{urllib.parse.quote('pipe5_%')}&select=campaign,user_name,status"
)
print(f"pipe5 DM送信ログ: {len(pipe5_logs)}件")

# Group by campaign
campaign_counts = defaultdict(lambda: {'total': 0, 'success': 0, 'users': set()})
for log in pipe5_logs:
    c = log.get('campaign', '')
    campaign_counts[c]['total'] += 1
    if log.get('status') == 'success':
        campaign_counts[c]['success'] += 1
    campaign_counts[c]['users'].add(log.get('user_name'))

# ============================================================
# SQL1: 送信済みユーザーの確認
# ============================================================
print("\n" + "=" * 90)
print("【SQL1】送信済みユーザーの確認（pipe5キャンペーン別）")
print("=" * 90)

print(f"\n{'campaign':<65} {'sent':>5} {'ok':>5} {'users':>5}")
print("-" * 85)
total_sent = 0
total_ok = 0
all_sent_users = set()
for c in sorted(campaign_counts.keys()):
    info = campaign_counts[c]
    users_count = len(info['users'])
    print(f"{c:<65} {info['total']:>5} {info['success']:>5} {users_count:>5}")
    total_sent += info['total']
    total_ok += info['success']
    all_sent_users.update(info['users'])
print("-" * 85)
print(f"{'TOTAL':<65} {total_sent:>5} {total_ok:>5} {len(all_sent_users):>5}")

# Also check for あいり 2/22 pattern specifically
airi_222_users = set()
for log in pipe5_logs:
    c = log.get('campaign', '')
    if '2/22' in c or '2%2F22' in c:
        airi_222_users.add(log.get('user_name'))
print(f"\n2/22キャンペーン送信済みユニークユーザー: {len(airi_222_users)}名")

# Use all pipe5 sent users for exclusion
sent_user_names = all_sent_users
print(f"全pipe5送信済みユニークユーザー: {len(sent_user_names)}名")

# ============================================================
# SQL2: 7/22以降に初課金したユーザー（送信済み除外）
# ============================================================
print("\n" + "=" * 90)
print("【SQL2】未送信ユーザーリスト（7/22以降初課金 & pipe5送信済み除外）")
print("=" * 90)

# Fetch all paid_users for hanshakun with first_payment_date
print("\nFetching paid_users for hanshakun...")
all_pu = api_get_all(
    "paid_users?cast_name=eq.hanshakun&select=user_name,segment,total_coins,last_payment_date,first_payment_date"
)
print(f"  -> {len(all_pu)} paid_users")

cutoff_first = datetime(2025, 7, 22, 0, 0, 0, tzinfo=JST)

def get_heat(lp_str):
    lp = parse_date(lp_str)
    if not lp:
        return 'Dormant'
    days = (now - lp).days
    if days <= 30:
        return 'Hot'
    elif days <= 60:
        return 'Warm'
    elif days <= 90:
        return 'AtRisk'
    else:
        return 'Dormant'

results = []
for pu in all_pu:
    fp = parse_date(pu.get('first_payment_date'))
    if not fp or fp < cutoff_first:
        continue
    un = pu['user_name']
    if un in sent_user_names:
        continue
    tc = pu.get('total_coins') or 0
    heat = get_heat(pu.get('last_payment_date'))
    results.append({
        'user_name': un,
        'segment': pu.get('segment') or 'NULL',
        'total_coins': tc,
        'last_payment_date': fmt_date(pu.get('last_payment_date')),
        'first_payment_date': fmt_date(pu.get('first_payment_date')),
        'estimated_visits': round(tc / 150.0, 1) if tc else 0,
        'heat_level': heat,
    })

results.sort(key=lambda x: x['total_coins'], reverse=True)

print(f"\n{'user_name':<28} {'seg':<10} {'coins':>7} {'visits':>6} {'heat':<8} {'first_paid':<12} {'last_paid':<12}")
print("-" * 95)
for r in results:
    print(f"{r['user_name']:<28} {r['segment']:<10} {r['total_coins']:>7} {r['estimated_visits']:>6} {r['heat_level']:<8} {r['first_payment_date']:<12} {r['last_payment_date']:<12}")
print(f"\n合計: {len(results)}名, 総coins: {sum(r['total_coins'] for r in results)}")

# CSV export
csv_path = 'C:/dev/livespot/scripts/dm_unsent_users.csv'
with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=['user_name', 'segment', 'total_coins', 'estimated_visits', 'heat_level', 'first_payment_date', 'last_payment_date'])
    writer.writeheader()
    writer.writerows(results)
print(f"\nCSV出力: {csv_path}")

# ============================================================
# SQL3: 分布サマリー
# ============================================================
print("\n" + "=" * 90)
print("【SQL3】熱度 x セグメント クロス集計表")
print("=" * 90)

cross = defaultdict(lambda: {'count': 0, 'total_coins': 0, 'coins_list': []})
for r in results:
    key = (r['segment'], r['heat_level'])
    cross[key]['count'] += 1
    cross[key]['total_coins'] += r['total_coins']
    cross[key]['coins_list'].append(r['total_coins'])

heat_order = {'Hot': 1, 'Warm': 2, 'AtRisk': 3, 'Dormant': 4}
cross_list = []
for (seg, heat), v in cross.items():
    avg_coins = round(sum(v['coins_list']) / len(v['coins_list'])) if v['coins_list'] else 0
    avg_visits = round(avg_coins / 150.0, 1) if avg_coins else 0
    cross_list.append({
        'segment': seg,
        'heat_level': heat,
        'user_count': v['count'],
        'total_coins': v['total_coins'],
        'avg_coins': avg_coins,
        'avg_visits': avg_visits,
    })
cross_list.sort(key=lambda x: (heat_order.get(x['heat_level'], 9), -x['total_coins']))

print(f"\n{'segment':<12} {'heat':<10} {'users':>6} {'total_coins':>12} {'avg_coins':>10} {'avg_visits':>10}")
print("-" * 65)
for r in cross_list:
    print(f"{r['segment']:<12} {r['heat_level']:<10} {r['user_count']:>6} {r['total_coins']:>12} {r['avg_coins']:>10} {r['avg_visits']:>10}")

# Grand totals
total_users = sum(r['user_count'] for r in cross_list)
total_coins = sum(r['total_coins'] for r in cross_list)
print("-" * 65)
print(f"{'TOTAL':<12} {'':<10} {total_users:>6} {total_coins:>12}")

# Heat summary
print("\n--- 熱度別サマリー ---")
heat_summary = defaultdict(lambda: {'count': 0, 'coins': 0})
for r in cross_list:
    heat_summary[r['heat_level']]['count'] += r['user_count']
    heat_summary[r['heat_level']]['coins'] += r['total_coins']
for h in ['Hot', 'Warm', 'AtRisk', 'Dormant']:
    if h in heat_summary:
        s = heat_summary[h]
        print(f"  {h:<10} {s['count']:>5}名  {s['coins']:>8} coins")
