# -*- coding: utf-8 -*-
"""
Prompt 22: セッション別 新規ユーザーリスト出力
get_new_users_by_session RPC (migration 047) の代替実装
RPC未適用でも coin_transactions 直接クエリで動作

使い方:
  python scripts/run_new_users_analysis.py                          # 全キャスト直近日
  python scripts/run_new_users_analysis.py --cast airi_love22 --date 2026-02-22
  python scripts/run_new_users_analysis.py --cast Risa_06 --date 2026-02-22
"""
import urllib.request, urllib.parse, json, csv, sys, argparse, os
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

JST = timezone(timedelta(hours=9))

# 環境変数 or backend/.env から読み込み
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SERVICE_KEY:
    env_path = Path(__file__).resolve().parent.parent / 'backend' / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip()
            if k == 'SUPABASE_URL' and not SUPABASE_URL:
                SUPABASE_URL = v
            elif k == 'SUPABASE_SERVICE_KEY' and not SERVICE_KEY:
                SERVICE_KEY = v

if not SUPABASE_URL or not SERVICE_KEY:
    print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。backend/.env を確認してください。")
    sys.exit(1)


def api_get_all(path, limit=1000):
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


def api_rpc(fn_name, params):
    """Supabase RPC呼び出し（RPCが存在する場合）"""
    url = f"{SUPABASE_URL}/rest/v1/rpc/{fn_name}"
    headers = {
        'apikey': SERVICE_KEY,
        'Authorization': f'Bearer {SERVICE_KEY}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    body = json.dumps(params).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        return None  # RPC未適用


def parse_date(d):
    if not d:
        return None
    try:
        return datetime.fromisoformat(d.replace('Z', '+00:00'))
    except Exception:
        return None


def fmt_datetime(d):
    dt = parse_date(d) if isinstance(d, str) else d
    if not dt:
        return '-'
    return dt.astimezone(JST).strftime('%Y-%m-%d %H:%M')


def fmt_date(d):
    dt = parse_date(d) if isinstance(d, str) else d
    if not dt:
        return '-'
    return dt.astimezone(JST).strftime('%Y-%m-%d')


def main():
    parser = argparse.ArgumentParser(description='セッション別 新規ユーザー分析')
    parser.add_argument('--cast', type=str, default=None, help='キャスト名 (例: airi_love22)')
    parser.add_argument('--date', type=str, default=None, help='対象日 YYYY-MM-DD (例: 2026-02-22)')
    parser.add_argument('--csv', action='store_true', help='CSV出力')
    args = parser.parse_args()

    target_date = args.date
    if not target_date:
        # デフォルト: 昨日（JST）
        yesterday = datetime.now(JST) - timedelta(days=1)
        target_date = yesterday.strftime('%Y-%m-%d')

    cast_name = args.cast

    print("=" * 100)
    print(f"セッション別 新規ユーザー分析")
    print(f"対象日: {target_date}  キャスト: {cast_name or '全キャスト'}")
    print("=" * 100)

    # ============================================================
    # Step 1: RPC呼び出し試行（migration 047 適用済みの場合）
    # ============================================================
    if cast_name:
        # account_id を取得
        accounts = api_get_all("accounts?select=id")
        if not accounts:
            print("ERROR: アカウントが見つかりません")
            return
        account_id = accounts[0]['id']

        print(f"\nAccount ID: {account_id}")
        print(f"RPC get_new_users_by_session を試行中...")

        rpc_result = api_rpc('get_new_users_by_session', {
            'p_account_id': account_id,
            'p_cast_name': cast_name,
            'p_session_date': target_date,
        })

        if rpc_result is not None:
            print(f"  -> RPC成功！ {len(rpc_result)}件")
            print_rpc_results(rpc_result, cast_name, target_date)
            if args.csv:
                export_csv(rpc_result, cast_name, target_date, 'rpc')
            return

        print("  -> RPC未適用。直接クエリで実行します。")

    # ============================================================
    # Step 2: 直接クエリ（RPC未適用時のフォールバック）
    # ============================================================
    # 対象日のUTC範囲（JST日付→UTC）
    date_start_jst = datetime.strptime(target_date, '%Y-%m-%d').replace(tzinfo=JST)
    date_end_jst = date_start_jst + timedelta(days=1)
    date_start_utc = date_start_jst.astimezone(timezone.utc).isoformat()
    date_end_utc = date_end_jst.astimezone(timezone.utc).isoformat()

    # 対象日のcoin_transactions取得
    query = f"coin_transactions?select=user_name,tokens,type,date,cast_name&tokens=gt.0&date=gte.{urllib.parse.quote(date_start_utc)}&date=lt.{urllib.parse.quote(date_end_utc)}"
    if cast_name:
        query += f"&cast_name=eq.{urllib.parse.quote(cast_name)}"

    print(f"\ncoin_transactions ({target_date} JST) を取得中...")
    day_txs = api_get_all(query)
    print(f"  -> {len(day_txs)}件のトランザクション")

    if not day_txs:
        print(f"\n{target_date} のトランザクションが見つかりません。")
        return

    # キャスト別にグループ化
    cast_groups = defaultdict(list)
    for tx in day_txs:
        cn = tx.get('cast_name') or 'unknown'
        cast_groups[cn].append(tx)

    # キャスト別に処理
    all_results = []
    for cn in sorted(cast_groups.keys()):
        txs = cast_groups[cn]
        results = analyze_cast(cn, target_date, txs, date_start_utc)
        all_results.extend(results)

    if args.csv and all_results:
        export_csv_direct(all_results, cast_name, target_date)


def analyze_cast(cast_name, target_date, day_txs, date_start_utc):
    """キャスト単位の新規/リピーター分析"""
    print(f"\n{'=' * 100}")
    print(f"キャスト: {cast_name}  対象日: {target_date}")
    print(f"{'=' * 100}")

    # ユーザー別集計
    user_agg = defaultdict(lambda: {'tokens': 0, 'count': 0, 'types': set(), 'first_tx': None, 'last_tx': None})
    for tx in day_txs:
        un = tx['user_name']
        tokens = int(tx.get('tokens', 0))
        user_agg[un]['tokens'] += tokens
        user_agg[un]['count'] += 1
        user_agg[un]['types'].add(tx.get('type', 'unknown'))
        tx_dt = parse_date(tx['date'])
        if tx_dt:
            if user_agg[un]['first_tx'] is None or tx_dt < user_agg[un]['first_tx']:
                user_agg[un]['first_tx'] = tx_dt
            if user_agg[un]['last_tx'] is None or tx_dt > user_agg[un]['last_tx']:
                user_agg[un]['last_tx'] = tx_dt

    user_names = list(user_agg.keys())
    print(f"ユニークユーザー: {len(user_names)}名")

    # 過去履歴チェック（バッチ）
    print(f"過去履歴チェック中...")
    prior_users = set()

    # 50名ずつバッチで過去トランザクションを確認
    for i in range(0, len(user_names), 50):
        batch = user_names[i:i + 50]
        # user_name IN () の代わりに or で組み立て
        or_conditions = ','.join(f'"{un}"' for un in batch)
        query = (
            f"coin_transactions?select=user_name&tokens=gt.0"
            f"&cast_name=eq.{urllib.parse.quote(cast_name)}"
            f"&date=lt.{urllib.parse.quote(date_start_utc)}"
            f"&user_name=in.({urllib.parse.quote(or_conditions)})"
            f"&limit=1000"
        )
        prior_txs = api_get_all(query, limit=1000)
        for ptx in prior_txs:
            prior_users.add(ptx['user_name'])

    # 分類
    results = []
    for un in user_names:
        agg = user_agg[un]
        is_new = un not in prior_users
        results.append({
            'cast_name': cast_name,
            'user_name': un,
            'total_tokens': agg['tokens'],
            'transaction_count': agg['count'],
            'types': list(agg['types']),
            'is_new': is_new,
            'first_tx_time': fmt_datetime(agg['first_tx']),
            'last_tx_time': fmt_datetime(agg['last_tx']),
        })

    results.sort(key=lambda x: (-int(x['is_new']), -x['total_tokens']))

    # 出力
    new_users = [r for r in results if r['is_new']]
    returning_users = [r for r in results if not r['is_new']]

    print(f"\n--- 新規ユーザー: {len(new_users)}名 ---")
    if new_users:
        print(f"{'user_name':<28} {'tokens':>8} {'txs':>4} {'types':<30} {'初回':>16} {'最終':>16}")
        print("-" * 110)
        for r in new_users:
            types_str = ', '.join(r['types'])
            print(f"{r['user_name']:<28} {r['total_tokens']:>8} {r['transaction_count']:>4} {types_str:<30} {r['first_tx_time']:>16} {r['last_tx_time']:>16}")
        new_total = sum(r['total_tokens'] for r in new_users)
        print(f"{'小計':<28} {new_total:>8}")

    print(f"\n--- リピーター: {len(returning_users)}名 ---")
    if returning_users:
        print(f"{'user_name':<28} {'tokens':>8} {'txs':>4} {'types':<30} {'初回':>16} {'最終':>16}")
        print("-" * 110)
        for r in returning_users:
            types_str = ', '.join(r['types'])
            print(f"{r['user_name']:<28} {r['total_tokens']:>8} {r['transaction_count']:>4} {types_str:<30} {r['first_tx_time']:>16} {r['last_tx_time']:>16}")
        ret_total = sum(r['total_tokens'] for r in returning_users)
        print(f"{'小計':<28} {ret_total:>8}")

    # サマリー
    total_tokens = sum(r['total_tokens'] for r in results)
    new_tokens = sum(r['total_tokens'] for r in new_users)
    ret_tokens = sum(r['total_tokens'] for r in returning_users)

    print(f"\n--- サマリー ---")
    print(f"  総売上:     {total_tokens:>8} tk")
    print(f"  新規売上:   {new_tokens:>8} tk ({round(new_tokens / total_tokens * 100, 1) if total_tokens else 0}%)")
    print(f"  リピ売上:   {ret_tokens:>8} tk ({round(ret_tokens / total_tokens * 100, 1) if total_tokens else 0}%)")
    print(f"  新規人数:   {len(new_users):>8} 名 ({round(len(new_users) / len(results) * 100, 1) if results else 0}%)")
    print(f"  リピ人数:   {len(returning_users):>8} 名")
    if new_users:
        print(f"  新規平均:   {round(new_tokens / len(new_users)):>8} tk/人")
    if returning_users:
        print(f"  リピ平均:   {round(ret_tokens / len(returning_users)):>8} tk/人")

    return results


def print_rpc_results(rpc_result, cast_name, target_date):
    """RPC結果の表示"""
    new_users = [r for r in rpc_result if not r.get('has_prior_history', True)]
    returning_users = [r for r in rpc_result if r.get('has_prior_history', False)]

    print(f"\n--- 新規ユーザー（初課金）: {len(new_users)}名 ---")
    if new_users:
        print(f"{'user_name':<28} {'tokens':>8} {'txs':>4} {'types':<30}")
        print("-" * 75)
        for r in new_users:
            types_str = ', '.join(r.get('types', []))
            print(f"{r['user_name']:<28} {r['total_tokens_on_date']:>8} {r['transaction_count']:>4} {types_str:<30}")
        new_total = sum(r['total_tokens_on_date'] for r in new_users)
        print(f"{'小計':<28} {new_total:>8}")

    print(f"\n--- リピーター: {len(returning_users)}名 ---")
    if returning_users:
        print(f"{'user_name':<28} {'tokens':>8} {'txs':>4} {'types':<30}")
        print("-" * 75)
        for r in returning_users:
            types_str = ', '.join(r.get('types', []))
            print(f"{r['user_name']:<28} {r['total_tokens_on_date']:>8} {r['transaction_count']:>4} {types_str:<30}")
        ret_total = sum(r['total_tokens_on_date'] for r in returning_users)
        print(f"{'小計':<28} {ret_total:>8}")

    total = sum(r['total_tokens_on_date'] for r in rpc_result)
    new_total = sum(r['total_tokens_on_date'] for r in new_users)
    print(f"\n--- サマリー ---")
    print(f"  総売上:     {total:>8} tk")
    print(f"  新規売上:   {new_total:>8} tk ({round(new_total / total * 100, 1) if total else 0}%)")
    print(f"  新規人数:   {len(new_users):>8} 名")
    print(f"  リピ人数:   {len(returning_users):>8} 名")


def export_csv(rpc_result, cast_name, target_date, source='rpc'):
    """RPC結果のCSV出力"""
    csv_path = f'C:/dev/livespot/scripts/new_users_{cast_name}_{target_date}.csv'
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'user_name', 'total_tokens', 'transaction_count', 'types', 'is_new'
        ])
        writer.writeheader()
        for r in rpc_result:
            writer.writerow({
                'user_name': r['user_name'],
                'total_tokens': r.get('total_tokens_on_date', 0),
                'transaction_count': r.get('transaction_count', 0),
                'types': ', '.join(r.get('types', [])),
                'is_new': not r.get('has_prior_history', True),
            })
    print(f"\nCSV出力: {csv_path}")


def export_csv_direct(results, cast_name, target_date):
    """直接クエリ結果のCSV出力"""
    suffix = cast_name or 'all'
    csv_path = f'C:/dev/livespot/scripts/new_users_{suffix}_{target_date}.csv'
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'cast_name', 'user_name', 'total_tokens', 'transaction_count',
            'types', 'is_new', 'first_tx_time', 'last_tx_time'
        ])
        writer.writeheader()
        for r in results:
            writer.writerow({
                'cast_name': r['cast_name'],
                'user_name': r['user_name'],
                'total_tokens': r['total_tokens'],
                'transaction_count': r['transaction_count'],
                'types': ', '.join(r['types']),
                'is_new': r['is_new'],
                'first_tx_time': r['first_tx_time'],
                'last_tx_time': r['last_tx_time'],
            })
    print(f"\nCSV出力: {csv_path}")


if __name__ == '__main__':
    main()
