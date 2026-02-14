"""
import_spy_csv.py - SPY CSVログをSupabase spy_messagesにインポート

Usage:
  python import_spy_csv.py <file1.csv> [file2.csv ...] --account-id <UUID> [options]
  python import_spy_csv.py spy_logs/Risa_06/*.csv --account-id <UUID> --dry-run

Options:
  --account-id UUID       アカウントID（必須）
  --gap-minutes N         セッション分割ギャップ（default: 5）
  --supabase-url URL      Supabase URL（default: .envから読み込み）
  --supabase-key KEY      Supabase Service Key（default: .envから読み込み）
  --dry-run               INSERTせずにサマリーのみ表示
  --batch-size N          一括INSERT件数（default: 500）

CSV Format (5-column):
  Time,Type,User,Level,Message
  21:48:08,💰,masagoro5379,47,55 coins: メッセージ

CSV Format (4-column, legacy):
  Time,Type,User,Message
"""

import argparse
import csv
import re
import sys
import uuid
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import requests
from dotenv import dotenv_values


# ============================================================
# CSV解析
# ============================================================

# ファイル名パターン: spy_log_<CastName>_YYYYMMDD_HHMMSS.csv
FILENAME_RE = re.compile(r'spy_log_(.+?)_(\d{8})_(\d{6})\.csv$')

# コイン数抽出: "55 coins" or "55 coins: メッセージ"
COINS_RE = re.compile(r'^(\d+)\s*coins?')


def parse_filename(filepath: str) -> tuple[str | None, str | None]:
    """ファイル名からキャスト名とYYYY-MM-DD日付を抽出"""
    match = FILENAME_RE.search(Path(filepath).name)
    if match:
        cast_name = match.group(1)
        d = match.group(2)
        date_str = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        return cast_name, date_str
    return None, None


def detect_columns(fieldnames: list[str]) -> bool:
    """5列フォーマット（Level列あり）かどうかを判定"""
    if fieldnames is None:
        return False
    cleaned = [f.strip().lstrip('\ufeff') for f in fieldnames]
    return "Level" in cleaned


def parse_row(row: dict, base_date: str, has_level: bool, cast_name: str | None) -> dict:
    """CSV行を解析してspy_message形式に変換"""
    time_str = row.get("Time", "").strip()
    type_emoji = row.get("Type", "").strip()
    user_raw = row.get("User", "").strip()
    message_raw = row.get("Message", "").strip()
    level_raw = row.get("Level", "").strip() if has_level else ""

    # タイムスタンプ
    timestamp = datetime.fromisoformat(f"{base_date}T{time_str}") if time_str else None

    # Level
    user_level = int(level_raw) if level_raw.isdigit() else None

    # User → user_name（そのまま使用）
    user_name = user_raw if user_raw and user_raw != "SYSTEM" else None

    # キャスト判定
    is_cast = (user_raw == cast_name) if cast_name and user_raw else False

    # Type emoji → msg_type + tokens解析
    msg_type = "chat"
    tokens = 0
    message = message_raw or None

    if type_emoji == "🟢":
        msg_type = "system"
        user_name = None

    elif type_emoji == "💰":
        msg_type = "tip"
        # "55 coins" or "1 coins: メッセージ"
        m = COINS_RE.match(message_raw)
        if m:
            tokens = int(m.group(1))
            # コイン部分の後のメッセージを取得
            rest = message_raw[m.end():].strip()
            if rest.startswith(":"):
                rest = rest[1:].strip()
            message = rest if rest else None

    elif type_emoji == "💬":
        msg_type = "chat"

    else:
        # 未知のType → chat扱い
        msg_type = "chat"

    return {
        "timestamp": timestamp,
        "msg_type": msg_type,
        "user_name": user_name,
        "message": message,
        "tokens": tokens,
        "user_level": user_level,
        "is_cast": is_cast,
    }


# ============================================================
# ファイル読み込み
# ============================================================

def load_csv_file(filepath: str, cast_name_override: str | None) -> tuple[list[dict], dict]:
    """CSVファイルを読み込んでパース済み行リスト + ファイルサマリーを返す"""
    path = Path(filepath)
    file_cast, base_date = parse_filename(str(path))

    cast_name = cast_name_override or file_cast

    if not base_date:
        print(f"  WARNING: {path.name} から日付を抽出できません。スキップ。")
        return [], {}

    # UTF-8 BOM対応
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        has_level = detect_columns(reader.fieldnames)
        raw_rows = list(reader)

    parsed = []
    errors = 0
    for i, row in enumerate(raw_rows):
        try:
            p = parse_row(row, base_date, has_level, cast_name)
            if p["timestamp"] is None:
                errors += 1
                continue
            p["_source_file"] = path.name
            p["_cast_name"] = cast_name or "unknown"
            parsed.append(p)
        except Exception as e:
            errors += 1
            if errors <= 3:
                print(f"  WARN {path.name} row {i+1}: {e}")

    # ファイル別サマリー
    file_summary = {
        "name": path.name,
        "total_rows": len(raw_rows),
        "parsed_rows": len(parsed),
        "errors": errors,
        "has_level": has_level,
        "base_date": base_date,
        "cast_name": cast_name,
    }
    if parsed:
        sorted_p = sorted(parsed, key=lambda r: r["timestamp"])
        file_summary["time_start"] = sorted_p[0]["timestamp"].strftime("%H:%M:%S")
        file_summary["time_end"] = sorted_p[-1]["timestamp"].strftime("%H:%M:%S")
        file_summary["unique_users"] = len(set(
            r["user_name"] for r in parsed if r["user_name"]
        ))

    return parsed, file_summary


# ============================================================
# セッション分割
# ============================================================

def split_sessions(rows: list[dict], gap_minutes: int) -> list[list[dict]]:
    """タイムスタンプのギャップでセッションに分割"""
    if not rows:
        return []

    sorted_rows = sorted(rows, key=lambda r: r["timestamp"])
    gap = timedelta(minutes=gap_minutes)

    sessions = []
    current = [sorted_rows[0]]

    for row in sorted_rows[1:]:
        if row["timestamp"] - current[-1]["timestamp"] > gap:
            sessions.append(current)
            current = [row]
        else:
            current.append(row)

    if current:
        sessions.append(current)

    return sessions


# ============================================================
# Supabase INSERT
# ============================================================

def supabase_insert(url: str, key: str, table: str, rows: list[dict], batch_size: int) -> int:
    """Supabase REST APIで一括INSERT（バッチ分割）"""
    endpoint = f"{url}/rest/v1/{table}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    total_inserted = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        resp = requests.post(endpoint, json=batch, headers=headers)
        if resp.status_code not in (200, 201):
            print(f"  ERROR batch {i//batch_size + 1}: {resp.status_code} {resp.text[:300]}")
            sys.exit(1)
        total_inserted += len(batch)
        print(f"  batch {i//batch_size + 1}: {len(batch)} rows inserted")

    return total_inserted


# ============================================================
# メイン
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="SPY CSVログをSupabaseにインポート")
    parser.add_argument("csv_files", nargs="+", help="CSVファイルパス（複数可、ワイルドカード対応）")
    parser.add_argument("--account-id", required=True, help="アカウントUUID")
    parser.add_argument("--gap-minutes", type=int, default=5, help="セッション分割ギャップ（分）")
    parser.add_argument("--supabase-url", help="Supabase URL")
    parser.add_argument("--supabase-key", help="Supabase Service Key")
    parser.add_argument("--dry-run", action="store_true", help="INSERTせずにサマリーのみ表示")
    parser.add_argument("--batch-size", type=int, default=500, help="一括INSERT件数")
    args = parser.parse_args()

    # --- 接続情報 ---
    sb_url = args.supabase_url
    sb_key = args.supabase_key

    if not args.dry_run:
        if not sb_url or not sb_key:
            env_path = Path(__file__).resolve().parent.parent / ".env"
            if env_path.exists():
                env = dotenv_values(env_path)
                sb_url = sb_url or env.get("SUPABASE_URL")
                sb_key = sb_key or env.get("SUPABASE_SERVICE_KEY")

        if not sb_url or not sb_key:
            print("ERROR: Supabase接続情報が不足。--supabase-url/--supabase-key か backend/.env を設定してください")
            sys.exit(1)

    # --- 全ファイル読み込み ---
    print("=" * 60)
    print("  SPY CSV Import")
    print("=" * 60)
    print(f"Account:     {args.account_id}")
    print(f"Gap minutes: {args.gap_minutes}")
    print(f"Files:       {len(args.csv_files)}")
    print()

    all_parsed = []
    file_summaries = []

    for filepath in sorted(args.csv_files):
        path = Path(filepath)
        if not path.exists():
            print(f"  SKIP: {filepath} (not found)")
            continue

        parsed, summary = load_csv_file(filepath, cast_name_override=None)
        all_parsed.extend(parsed)
        if summary:
            file_summaries.append(summary)

    # --- ファイル別サマリー ---
    print("--- File Summary ---")
    for s in file_summaries:
        time_range = f"{s.get('time_start', '?')} - {s.get('time_end', '?')}"
        level_tag = " [5col+Level]" if s.get("has_level") else " [4col]"
        print(f"  {s['name']}{level_tag}")
        print(f"    {s['parsed_rows']}/{s['total_rows']} rows | {time_range} | {s.get('unique_users', 0)} users"
              + (f" | {s['errors']} errors" if s['errors'] else ""))
    print()

    if not all_parsed:
        print("No valid rows to import.")
        sys.exit(0)

    # --- タイムスタンプ順にソート ---
    all_parsed.sort(key=lambda r: r["timestamp"])

    # --- セッション分割 ---
    sessions = split_sessions(all_parsed, args.gap_minutes)
    print(f"--- Sessions ({len(sessions)}, gap={args.gap_minutes}min) ---")

    session_metas = []
    all_spy_rows = []

    for idx, sess_rows in enumerate(sessions):
        sid = str(uuid.uuid4())
        started = sess_rows[0]["timestamp"]
        ended = sess_rows[-1]["timestamp"]
        cast_name = sess_rows[0]["_cast_name"]
        date_str = started.strftime("%Y-%m-%d")
        title = f"{date_str} Session {idx + 1}"
        tip_rows = [r for r in sess_rows if r["msg_type"] == "tip"]
        unique = set(r["user_name"] for r in sess_rows if r["user_name"])
        total_coins = sum(r["tokens"] for r in sess_rows)

        session_metas.append({
            "account_id": args.account_id,
            "session_id": sid,
            "title": title,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
            "total_messages": len(sess_rows),
            "total_tips": len(tip_rows),
            "total_coins": total_coins,
            "unique_users": len(unique),
        })

        for row in sess_rows:
            all_spy_rows.append({
                "account_id": args.account_id,
                "cast_name": row["_cast_name"],
                "session_id": sid,
                "session_title": title,
                "message_time": row["timestamp"].isoformat(),
                "msg_type": row["msg_type"],
                "user_name": row["user_name"],
                "message": row["message"],
                "tokens": row["tokens"],
                "is_vip": False,
                "user_level": row["user_level"],
                "metadata": {"is_cast": row["is_cast"]},
            })

        duration = ended - started
        mins = int(duration.total_seconds() / 60)
        print(f"  #{idx+1}: {started.strftime('%m/%d %H:%M:%S')} - {ended.strftime('%H:%M:%S')} ({mins}min)")
        print(f"       {len(sess_rows)} msgs, {len(tip_rows)} tips, {total_coins} coins, {len(unique)} users")

    # --- 全体サマリー ---
    print()
    print("=" * 60)
    print("  Overall Summary")
    print("=" * 60)

    type_counts = Counter(r["msg_type"] for r in all_parsed)
    unique_users = set(r["user_name"] for r in all_parsed if r["user_name"])
    cast_msgs = sum(1 for r in all_parsed if r["is_cast"])
    total_coins = sum(r["tokens"] for r in all_parsed)
    time_start = all_parsed[0]["timestamp"].strftime("%Y-%m-%d %H:%M:%S")
    time_end = all_parsed[-1]["timestamp"].strftime("%Y-%m-%d %H:%M:%S")

    print(f"Total rows:    {len(all_parsed)}")
    print(f"Sessions:      {len(sessions)}")
    print(f"Time range:    {time_start} → {time_end}")
    print(f"Unique users:  {len(unique_users)}")
    print(f"Cast msgs:     {cast_msgs} (is_cast=true)")
    print(f"Total coins:   {total_coins}")
    print()

    print("By msg_type:")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t:10s} {c:>6d}")
    print()

    # トップユーザー（メッセージ数上位5名）
    user_msg_counts = Counter(
        r["user_name"] for r in all_parsed
        if r["user_name"] and not r["is_cast"]
    )
    print("Top 5 users (by messages, excl. cast):")
    for rank, (user, count) in enumerate(user_msg_counts.most_common(5), 1):
        coins = sum(r["tokens"] for r in all_parsed if r["user_name"] == user)
        level = next((r["user_level"] for r in all_parsed if r["user_name"] == user and r["user_level"]), None)
        lvl_str = f" Lv.{level}" if level else ""
        coin_str = f" ({coins} coins)" if coins else ""
        print(f"  {rank}. {user}{lvl_str}: {count} msgs{coin_str}")
    print()

    # トップチッパー（コイン上位5名）
    user_coins = Counter()
    for r in all_parsed:
        if r["user_name"] and r["tokens"] > 0 and not r["is_cast"]:
            user_coins[r["user_name"]] += r["tokens"]
    if user_coins:
        print("Top 5 tippers (by coins, excl. cast):")
        for rank, (user, coins) in enumerate(user_coins.most_common(5), 1):
            tip_count = sum(1 for r in all_parsed if r["user_name"] == user and r["msg_type"] == "tip")
            print(f"  {rank}. {user}: {coins} coins ({tip_count} tips)")
        print()

    if args.dry_run:
        print("[DRY RUN] INSERTをスキップしました")
        return

    # --- INSERT ---
    print("Inserting spy_messages...")
    inserted = supabase_insert(sb_url, sb_key, "spy_messages", all_spy_rows, args.batch_size)
    print(f"  -> {inserted} rows inserted")
    print()

    print("Inserting sessions...")
    supabase_insert(sb_url, sb_key, "sessions", session_metas, args.batch_size)
    print(f"  -> {len(session_metas)} sessions inserted")
    print()

    print("Import complete!")


if __name__ == "__main__":
    main()
