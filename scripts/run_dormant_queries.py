# -*- coding: utf-8 -*-
"""
Dormant層テスト送信用リスト抽出
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
        headers = {'apikey': SERVICE_KEY, 'Authorization': f'Bearer {SERVICE_KEY}', 'Accept': 'application/json'}
        req = urllib.request.Request(url, headers=headers)
        resp = urllib.request.urlopen(req)
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
cutoff_first = datetime(2025, 7, 22, 0, 0, 0, tzinfo=JST)
dormant_cutoff = now - timedelta(days=90)

# --- Fetch sent users ---
print("Fetching pipe5 sent users...")
import urllib.parse
pipe5_logs = api_get_all(f"dm_send_log?campaign=like.{urllib.parse.quote('pipe5_%')}&select=user_name")
sent_users = set(log['user_name'] for log in pipe5_logs)
print(f"  -> {len(sent_users)} sent users excluded")

# --- Fetch paid_users ---
print("Fetching paid_users for hanshakun...")
all_pu = api_get_all("paid_users?cast_name=eq.hanshakun&select=user_name,segment,total_coins,last_payment_date,first_payment_date")
print(f"  -> {len(all_pu)} paid_users")

# --- Filter: 7/22以降初課金, 送信済み除外, Dormant ---
dormant_all = []
for pu in all_pu:
    fp = parse_date(pu.get('first_payment_date'))
    lp = parse_date(pu.get('last_payment_date'))
    if not fp or fp < cutoff_first:
        continue
    if pu['user_name'] in sent_users:
        continue
    if not lp or lp >= dormant_cutoff:
        continue
    tc = pu.get('total_coins') or 0
    dormant_all.append({
        'user_name': pu['user_name'],
        'segment': pu.get('segment') or 'NULL',
        'total_coins': tc,
        'first_payment_date': pu.get('first_payment_date'),
        'last_payment_date': pu.get('last_payment_date'),
        'estimated_visits': round(tc / 150.0, 1),
    })

dormant_all.sort(key=lambda x: x['total_coins'], reverse=True)
target = [d for d in dormant_all if d['total_coins'] >= 300]
excluded = [d for d in dormant_all if d['total_coins'] < 300]

# ============================================================
# SQL2: Dormant分布サマリー（先に出す）
# ============================================================
print("\n" + "=" * 70)
print("【SQL2】Dormant分布サマリー")
print("=" * 70)

def summary(label, lst):
    cnt = len(lst)
    total = sum(d['total_coins'] for d in lst)
    avg = round(total / cnt) if cnt else 0
    return {'category': label, 'users': cnt, 'total_coins': total, 'avg_coins': avg}

rows = [
    summary('Dormant全体', dormant_all),
    summary('300tk以上（テスト対象）', target),
    summary('300tk未満（今回送らない）', excluded),
]

print(f"\n{'category':<30} {'users':>7} {'total_coins':>12} {'avg_coins':>10}")
print("-" * 62)
for r in rows:
    print(f"{r['category']:<30} {r['users']:>7} {r['total_coins']:>12} {r['avg_coins']:>10}")

# ============================================================
# SQL1: テスト送信対象リスト
# ============================================================
print("\n" + "=" * 70)
print("【SQL1】テスト送信対象リスト（Dormant, coins>=300）")
print("=" * 70)

output_list = target[:500] if len(target) > 500 else target
capped = len(target) > 500

print(f"\n{'user_name':<28} {'seg':<10} {'coins':>7} {'visits':>6} {'first_paid':<12} {'last_paid':<12}")
print("-" * 80)
for r in output_list:
    print(f"{r['user_name']:<28} {r['segment']:<10} {r['total_coins']:>7} {r['estimated_visits']:>6} {fmt_date(r['first_payment_date']):<12} {fmt_date(r['last_payment_date']):<12}")

if capped:
    print(f"\n（上位500名のみ表示。全{len(target)}名中）")
print(f"\n合計: {len(output_list)}名, 総coins: {sum(r['total_coins'] for r in output_list)}")

# --- CSV export ---
csv_path = 'C:/dev/livespot/scripts/dm_dormant_target.csv'
with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=['user_name', 'segment', 'total_coins', 'estimated_visits', 'first_payment_date', 'last_payment_date'])
    writer.writeheader()
    for r in output_list:
        writer.writerow({
            'user_name': r['user_name'],
            'segment': r['segment'],
            'total_coins': r['total_coins'],
            'estimated_visits': r['estimated_visits'],
            'first_payment_date': fmt_date(r['first_payment_date']),
            'last_payment_date': fmt_date(r['last_payment_date']),
        })
print(f"CSV出力: {csv_path} ({len(output_list)}名)")

# --- Segment breakdown of target ---
print("\n--- テスト対象のセグメント内訳 ---")
seg_counts = defaultdict(lambda: {'count': 0, 'coins': 0})
for r in target:
    seg_counts[r['segment']]['count'] += 1
    seg_counts[r['segment']]['coins'] += r['total_coins']
for seg in sorted(seg_counts.keys(), key=lambda s: -seg_counts[s]['coins']):
    s = seg_counts[seg]
    print(f"  {seg:<12} {s['count']:>5}名  {s['coins']:>8} coins  avg={round(s['coins']/s['count'])}tk")
