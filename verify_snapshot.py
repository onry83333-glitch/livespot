"""
Strip Live Spot スナップショット検証スクリプト
現在のDBスナップショットを取得して詳細レポートを出力
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import requests
from datetime import datetime, timezone, timedelta
from collections import Counter

# ── 設定 ──────────────────────────────────────────────
SUPABASE_URL = "https://ujgbhkllfeacbgpdbjto.supabase.co"
ANON_KEY = "sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ"
EMAIL = "admin@livespot.jp"
PASSWORD = "livespot2024"
ACCOUNT_ID = "940e7248-1d73-4259-a538-56fdaea9d740"
JST = timezone(timedelta(hours=9))

TABLES = [
    "profiles", "accounts", "paid_users", "coin_transactions",
    "paying_users", "dm_send_log", "dm_templates", "spy_messages",
    "broadcast_scripts", "ai_reports", "audio_recordings",
    "sessions", "viewer_stats", "feed_posts",
]


# ── 認証 ──────────────────────────────────────────────
def authenticate():
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        json={"email": EMAIL, "password": PASSWORD},
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def hdr(token):
    return {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "count=exact",
    }


def count_table(token, table):
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}?select=id&limit=0",
        headers=hdr(token),
        timeout=10,
    )
    if r.status_code >= 400:
        return None
    ct = r.headers.get("content-range", "")
    # format: "0-0/123" or "*/0" or "*/123"
    if "/" in ct:
        total = ct.split("/")[-1]
        return int(total) if total != "*" else None
    return None


def query(token, table, params=""):
    h = hdr(token)
    h.pop("Prefer", None)
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    r = requests.get(url, headers=h, timeout=15)
    r.raise_for_status()
    return r.json()


def section(title):
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


# ── メイン ────────────────────────────────────────────
def main():
    print("🔐 認証中...")
    token = authenticate()
    now_jst = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S JST")
    print(f"✅ 認証成功")
    print(f"\n{'=' * 60}")
    print(f"  Strip Live Spot DB スナップショット")
    print(f"  取得時刻: {now_jst}")
    print(f"{'=' * 60}")

    # ── 1. 全テーブル行数 ─────────────────────────────
    section("1. テーブル別行数")
    for t in TABLES:
        c = count_table(token, t)
        indicator = ""
        if c is not None and c > 0:
            indicator = " ✅"
        elif c == 0:
            indicator = " ⚪"
        else:
            indicator = " ❌"
        print(f"  {t:<25} {str(c) if c is not None else 'N/A':>8}{indicator}")

    # ── 2. spy_messages cast_name 別統計 ──────────────
    section("2. spy_messages キャスト別統計")
    spy_all = query(
        token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}"
        f"&select=cast_name,msg_type,tokens,message_time,user_name"
        f"&order=message_time.desc&limit=5000",
    )
    total_spy = len(spy_all)
    print(f"  取得件数: {total_spy}")

    if spy_all:
        cast_stats = {}
        for m in spy_all:
            cn = m.get("cast_name") or "(null)"
            if cn not in cast_stats:
                cast_stats[cn] = {"count": 0, "tips": 0, "tip_tokens": 0, "users": set()}
            cast_stats[cn]["count"] += 1
            if m.get("msg_type") in ("tip", "gift"):
                cast_stats[cn]["tips"] += 1
                cast_stats[cn]["tip_tokens"] += m.get("tokens") or 0
            if m.get("user_name"):
                cast_stats[cn]["users"].add(m["user_name"])

        print(f"\n  {'キャスト':<20} {'MSG':>6} {'TIP件':>6} {'TIP(tk)':>8} {'ユーザー':>8}")
        print(f"  {'─' * 52}")
        for cn, s in sorted(cast_stats.items(), key=lambda x: -x[1]["count"]):
            print(f"  {cn:<20} {s['count']:>6} {s['tips']:>6} {s['tip_tokens']:>8} {len(s['users']):>8}")

    # ── 3. ユーザー TOP20 ────────────────────────────
    section("3. ユーザー TOP20（メッセージ数順）")
    if spy_all:
        user_counter = Counter()
        user_tokens = Counter()
        for m in spy_all:
            un = m.get("user_name")
            if un:
                user_counter[un] += 1
                user_tokens[un] += m.get("tokens") or 0

        print(f"\n  {'#':<4} {'ユーザー名':<25} {'MSG数':>6} {'TIP(tk)':>8} {'円換算':>10}")
        print(f"  {'─' * 58}")
        for i, (name, cnt) in enumerate(user_counter.most_common(20), 1):
            tk = user_tokens[name]
            jpy = f"¥{int(tk * 7.7):,}" if tk > 0 else "—"
            print(f"  {i:<4} {name:<25} {cnt:>6} {tk:>8} {jpy:>10}")

    # ── 4. チップ/ギフトメッセージ抽出 ────────────────
    section("4. チップ/ギフトメッセージ")
    if spy_all:
        tips = [m for m in spy_all if m.get("msg_type") in ("tip", "gift") and (m.get("tokens") or 0) > 0]
        tips.sort(key=lambda m: -(m.get("tokens") or 0))

        if tips:
            total_tk = sum(m.get("tokens") or 0 for m in tips)
            print(f"  合計: {len(tips)}件, {total_tk:,} tk (¥{int(total_tk * 7.7):,})")
            print(f"\n  {'時刻':<12} {'キャスト':<15} {'ユーザー':<20} {'tk':>6} {'メッセージ'}")
            print(f"  {'─' * 70}")
            for m in tips[:30]:
                t = datetime.fromisoformat(m["message_time"].replace("Z", "+00:00")).astimezone(JST)
                ts = t.strftime("%m/%d %H:%M")
                cn = m.get("cast_name") or "?"
                un = m.get("user_name") or "?"
                tk = m.get("tokens") or 0
                msg = (m.get("message") or "—")[:25]
                print(f"  {ts:<12} {cn:<15} {un:<20} {tk:>6} {msg}")
        else:
            print("  チップ/ギフトメッセージなし")

    # ── 5. 時間帯別メッセージ数 ───────────────────────
    section("5. 時間帯別メッセージ数 (JST)")
    if spy_all:
        hour_counts = [0] * 24
        for m in spy_all:
            try:
                t = datetime.fromisoformat(m["message_time"].replace("Z", "+00:00")).astimezone(JST)
                hour_counts[t.hour] += 1
            except (ValueError, KeyError):
                pass

        max_h = max(hour_counts) if max(hour_counts) > 0 else 1
        for h in range(24):
            bar_len = int((hour_counts[h] / max_h) * 40)
            bar = "█" * bar_len
            count_str = f"{hour_counts[h]:>5}" if hour_counts[h] > 0 else "    0"
            print(f"  {h:02d}:00 {count_str} {bar}")

    # ── 6. 日別メッセージ数 ──────────────────────────
    section("6. 日別メッセージ推移")
    if spy_all:
        day_counts = Counter()
        for m in spy_all:
            try:
                t = datetime.fromisoformat(m["message_time"].replace("Z", "+00:00")).astimezone(JST)
                day_counts[t.strftime("%Y-%m-%d")] += 1
            except (ValueError, KeyError):
                pass

        if day_counts:
            max_d = max(day_counts.values())
            for day in sorted(day_counts.keys()):
                c = day_counts[day]
                bar_len = int((c / max_d) * 40)
                bar = "█" * bar_len
                print(f"  {day} {c:>5} {bar}")

    # ── 7. msg_type 分布 ─────────────────────────────
    section("7. msg_type 分布")
    if spy_all:
        type_counts = Counter(m.get("msg_type") or "(null)" for m in spy_all)
        total = sum(type_counts.values())
        for mt, cnt in type_counts.most_common():
            pct = (cnt / total * 100) if total > 0 else 0
            bar_len = int(pct / 2)
            print(f"  {mt:<12} {cnt:>6} ({pct:5.1f}%) {'█' * bar_len}")

    # ── 8. セッション & viewer_stats ─────────────────
    section("8. セッション & viewer_stats")
    try:
        sessions = query(
            token, "sessions",
            f"account_id=eq.{ACCOUNT_ID}&select=*&order=started_at.desc&limit=5",
        )
        if sessions:
            for s in sessions:
                started = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(JST)
                ended = s.get("ended_at")
                ended_str = ""
                if ended:
                    ended_dt = datetime.fromisoformat(ended.replace("Z", "+00:00")).astimezone(JST)
                    ended_str = f" → {ended_dt.strftime('%H:%M')}"
                cn = s.get("cast_name") or "?"
                print(f"  {started.strftime('%Y-%m-%d %H:%M')}{ended_str} | {cn} | viewers: {s.get('peak_viewers', '?')}")
        else:
            print("  セッションなし")
    except Exception as e:
        print(f"  取得エラー: {e}")

    try:
        viewer = query(
            token, "viewer_stats",
            f"account_id=eq.{ACCOUNT_ID}&select=*&order=recorded_at.desc&limit=3",
        )
        if viewer:
            for v in viewer:
                t = datetime.fromisoformat(v["recorded_at"].replace("Z", "+00:00")).astimezone(JST)
                print(f"  viewer_stats: {t.strftime('%Y-%m-%d %H:%M')} | count: {v.get('viewer_count', '?')}")
        else:
            print("  viewer_stats: なし")
    except Exception as e:
        print(f"  viewer_stats 取得エラー: {e}")

    print(f"\n{'=' * 60}")
    print(f"  検証完了")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    main()
