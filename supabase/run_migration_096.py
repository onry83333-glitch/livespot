"""096_dm_queue_cleanup マイグレーション実行スクリプト

使い方:
  python supabase/run_migration_096.py --password YOUR_DB_PASSWORD

  または環境変数:
  set SUPABASE_DB_PASSWORD=YOUR_DB_PASSWORD
  python supabase/run_migration_096.py

パスワード取得方法:
  Supabase Dashboard → Project Settings → Database → Connection string
  のPasswordフィールドからコピー
"""
import argparse
import os
import sys

def main():
    parser = argparse.ArgumentParser(description="096 migration runner")
    parser.add_argument("--password", "-p", help="Supabase DB password")
    parser.add_argument("--dry-run", action="store_true", help="Show SQL without executing")
    args = parser.parse_args()

    password = args.password or os.environ.get("SUPABASE_DB_PASSWORD")
    if not password and not args.dry_run:
        print("ERROR: --password または SUPABASE_DB_PASSWORD 環境変数が必要です")
        print("Supabase Dashboard → Project Settings → Database → Connection string から取得")
        sys.exit(1)

    sql_statements = [
        # Step 1: CHECK制約を更新（cancelled を追加）
        "ALTER TABLE public.dm_send_log DROP CONSTRAINT IF EXISTS dm_send_log_status_check;",
        "ALTER TABLE public.dm_send_log ADD CONSTRAINT dm_send_log_status_check CHECK (status IN ('success', 'error', 'pending', 'queued', 'sending', 'cancelled'));",
        # Step 2: 滞留queued 150件を cancelled に更新
        "UPDATE public.dm_send_log SET status = 'cancelled' WHERE status = 'queued';",
        # Step 3: cast_name NOT NULL制約
        "UPDATE public.dm_send_log SET cast_name = '' WHERE cast_name IS NULL;",
        "ALTER TABLE public.dm_send_log ALTER COLUMN cast_name SET NOT NULL;",
        "ALTER TABLE public.dm_send_log ALTER COLUMN cast_name SET DEFAULT '';",
    ]

    if args.dry_run:
        print("=== DRY RUN: 以下のSQLが実行されます ===\n")
        for i, sql in enumerate(sql_statements, 1):
            print(f"  [{i}] {sql}")
        print(f"\n合計 {len(sql_statements)} ステートメント")
        return

    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 がインストールされていません")
        print("  pip install psycopg2-binary")
        sys.exit(1)

    conn_params = {
        "host": "aws-0-ap-northeast-1.pooler.supabase.com",
        "port": 5432,
        "dbname": "postgres",
        "user": "postgres.ujgbhkllfeacbgpdbjto",
        "password": password,
        "connect_timeout": 15,
    }

    print("Supabase PostgreSQL に接続中...")
    try:
        conn = psycopg2.connect(**conn_params)
        conn.autocommit = True
        cur = conn.cursor()
        print("接続成功\n")

        for i, sql in enumerate(sql_statements, 1):
            print(f"  [{i}/{len(sql_statements)}] {sql[:60]}...")
            cur.execute(sql)
            if cur.statusmessage:
                print(f"    → {cur.statusmessage}")

        # 確認クエリ
        cur.execute("SELECT status, count(*) FROM public.dm_send_log GROUP BY status ORDER BY count(*) DESC;")
        rows = cur.fetchall()
        print("\n=== 実行後のステータス分布 ===")
        for status, count in rows:
            print(f"  {status}: {count}件")

        cur.close()
        conn.close()
        print("\nマイグレーション完了")

    except psycopg2.OperationalError as e:
        print(f"接続失敗: {e}")
        print("\nヒント:")
        print("  - パスワードが正しいか確認")
        print("  - Supabase Dashboard → Project Settings → Database")
        sys.exit(1)
    except psycopg2.Error as e:
        print(f"SQL実行エラー: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
