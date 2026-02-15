"""
Strip Live Spot リアルタイム検証スクリプト
5秒ごとにspy_messagesを監視し、データ整合性をチェック
Ctrl+C で停止
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import requests
import time
from datetime import datetime, timezone, timedelta

# ── 設定 ──────────────────────────────────────────────
SUPABASE_URL = "https://ujgbhkllfeacbgpdbjto.supabase.co"
ANON_KEY = "sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ"
EMAIL = "admin@livespot.jp"
PASSWORD = "livespot2024"
ACCOUNT_ID = "940e7248-1d73-4259-a538-56fdaea9d740"
JST = timezone(timedelta(hours=9))
INTERVAL = 5

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


def headers(token):
    return {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def query(token, table, params=""):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    r = requests.get(url, headers=headers(token), timeout=10)
    r.raise_for_status()
    return r.json()


def ts_param(dt):
    """URL-safe ISO timestamp (encode + as %2B)"""
    return dt.isoformat().replace("+", "%2B")


# ── チェック関数 ──────────────────────────────────────
def check_spy(token, prev_count):
    now_utc = datetime.now(timezone.utc)
    since = ts_param(now_utc - timedelta(minutes=5))

    # 直近5分のメッセージ
    recent = query(
        token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&message_time=gte.{since}"
        f"&select=id,message_time,cast_name,user_name,message,msg_type,tokens"
        f"&order=message_time.desc",
    )
    count = len(recent)

    # cast_name 別カウント
    cast_counts = {}
    for m in recent:
        cn = m.get("cast_name") or "(null)"
        cast_counts[cn] = cast_counts.get(cn, 0) + 1
    cast_str = ", ".join(f"{k}({v}件)" for k, v in sorted(cast_counts.items(), key=lambda x: -x[1]))

    # 新着判定
    new_count = count - prev_count if prev_count is not None and count > prev_count else 0

    # 最新5件
    top5 = recent[:5]
    lines = []
    for m in top5:
        t = datetime.fromisoformat(m["message_time"].replace("Z", "+00:00")).astimezone(JST)
        ts = t.strftime("%H:%M:%S")
        cn = m.get("cast_name") or "?"
        un = m.get("user_name") or "SYSTEM"
        msg = (m.get("message") or "—")[:30]
        tk = m.get("tokens") or 0
        tk_str = f" [{tk}tk]" if tk > 0 else ""
        lines.append(f"  {ts} [{cn}] {un} : {msg}{tk_str}")

    return count, cast_str, new_count, lines


def check_integrity(token):
    # account_id 不一致
    other = query(
        token, "spy_messages",
        f"account_id=neq.{ACCOUNT_ID}&select=id&limit=1",
    )
    wrong_account = len(other) > 0

    # cast_name null
    null_cast = query(
        token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&cast_name=is.null&select=id",
    )

    # user_name null (SYSTEM除外)
    null_user = query(
        token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&user_name=is.null&msg_type=neq.system&select=id",
    )

    # 重複チェック (直近100件のmessage_time+user_name+message)
    last100 = query(
        token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}"
        f"&select=message_time,user_name,message"
        f"&order=message_time.desc&limit=100",
    )
    seen = set()
    dupes = 0
    for m in last100:
        key = (m.get("message_time"), m.get("user_name"), m.get("message"))
        if key in seen:
            dupes += 1
        seen.add(key)

    ok = not wrong_account and len(null_cast) == 0 and dupes == 0
    status = "OK" if ok else "NG"
    detail = f"null_cast: {len(null_cast)}, null_user(非SYSTEM): {len(null_user)}, 重複: {dupes}"
    if wrong_account:
        detail += ", ⚠️ 他アカウントデータあり"

    return status, detail


def check_sessions(token):
    sessions = query(
        token, "sessions",
        f"account_id=eq.{ACCOUNT_ID}&select=*&order=started_at.desc&limit=1",
    )
    viewer = query(
        token, "viewer_stats",
        f"account_id=eq.{ACCOUNT_ID}&select=*&order=recorded_at.desc&limit=1",
    )

    s_str = "なし"
    if sessions:
        s = sessions[0]
        started = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(JST)
        s_str = f"1件 (最新: {started.strftime('%Y-%m-%d %H:%M')})"

    v_str = "なし"
    if viewer:
        v_str = f"{len(viewer)}件"

    return s_str, v_str


# ── メインループ ──────────────────────────────────────
def main():
    print("🔐 認証中...")
    token = authenticate()
    print("✅ 認証成功\n")

    prev_count = None

    try:
        while True:
            now_jst = datetime.now(JST).strftime("%H:%M:%S")

            try:
                count, cast_str, new_count, lines = check_spy(token, prev_count)
                status, detail = check_integrity(token)
                s_str, v_str = check_sessions(token)

                new_badge = f" | 🆕 新着 {new_count}件" if new_count > 0 else ""
                print(f"\n===== Strip Live Spot リアルタイム検証 [{now_jst} JST] =====")
                print(f"📊 直近5分: {count}件 | キャスト: {cast_str}{new_badge}")
                if lines:
                    print("🆕 最新メッセージ:")
                    for l in lines:
                        print(l)
                else:
                    print("  (直近5分のメッセージなし)")
                print(f"✅ データ整合性: {status} ({detail})")
                print(f"📡 セッション: {s_str} | viewer_stats: {v_str}")
                print("=" * 56)

                prev_count = count

            except requests.exceptions.HTTPError as e:
                if e.response is not None and e.response.status_code == 401:
                    print("🔄 トークン再取得...")
                    token = authenticate()
                else:
                    print(f"❌ エラー: {e}")

            time.sleep(INTERVAL)

    except KeyboardInterrupt:
        print("\n\n🛑 監視を停止しました")
        sys.exit(0)


if __name__ == "__main__":
    main()
