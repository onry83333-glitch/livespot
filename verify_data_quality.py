"""
Strip Live Spot データ品質チェッカー
使い方: python verify_data_quality.py
"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import requests
from datetime import datetime, timezone, timedelta

# ── 設定 ──────────────────────────────────────────────
SUPABASE_URL = "https://ujgbhkllfeacbgpdbjto.supabase.co"
ANON_KEY = "sb_publishable_kt56F7VPKZyFIoja-UGHeQ_YVMEQdAZ"
EMAIL = "admin@livespot.jp"
PASSWORD = "livespot2024"
ACCOUNT_ID = "940e7248-1d73-4259-a538-56fdaea9d740"
JST = timezone(timedelta(hours=9))


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


def query(token, table, params="", count=False):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    h = headers(token)
    if count:
        h["Prefer"] = "count=exact"
    r = requests.get(url, headers=h, timeout=10)
    r.raise_for_status()
    if count:
        cr = r.headers.get("content-range", "")
        total = cr.split("/")[-1] if "/" in cr else "?"
        return r.json(), total
    return r.json()


def main():
    print("=" * 60)
    print("Strip Live Spot データ品質チェック")
    print(f"実行時刻: {datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S JST')}")
    print("=" * 60)

    token = authenticate()
    issues = 0

    # 1. 総件数
    _, total = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&select=id", count=True)
    print(f"\n総メッセージ数: {total}")

    # 2. 500文字超メッセージ
    long_msgs = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}"
        f"&select=id,user_name,message,msg_type"
        f"&order=created_at.desc")
    long_msgs = [m for m in long_msgs if m.get("message") and len(m["message"]) > 500]
    print(f"\n[チェック1] 500文字超メッセージ: {len(long_msgs)} 件")
    if long_msgs:
        issues += len(long_msgs)
        for m in long_msgs[:5]:
            print(f"  id={m['id']} user={m.get('user_name','?')} len={len(m['message'])} "
                  f"preview={m['message'][:60]}...")

    # 3. メッセージ=ユーザー名
    all_msgs = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&msg_type=eq.chat"
        f"&select=id,user_name,message"
        f"&order=created_at.desc")
    dup_name = [m for m in all_msgs
                if m.get("message") and m.get("user_name")
                and m["message"].strip() == m["user_name"].strip()]
    print(f"\n[チェック2] メッセージ=ユーザー名 (chatのみ): {len(dup_name)} 件")
    if dup_name:
        issues += len(dup_name)
        for m in dup_name[:5]:
            print(f"  id={m['id']} user={m['user_name']}")

    # 4. 重複チェック（直近200件）
    recent = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}"
        f"&select=message_time,user_name,message,msg_type"
        f"&order=message_time.desc&limit=200")
    seen = set()
    dupes = 0
    for m in recent:
        key = (m.get("message_time"), m.get("user_name"), m.get("message"))
        if key in seen:
            dupes += 1
        seen.add(key)
    print(f"\n[チェック3] 直近200件の重複: {dupes} 件")
    if dupes:
        issues += dupes

    # 5. msg_type分布
    type_dist = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}"
        f"&select=msg_type"
        f"&order=created_at.desc")
    type_counts = {}
    for m in type_dist:
        t = m.get("msg_type") or "(null)"
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f"\n[チェック4] msg_type分布:")
    valid_types = {"chat", "tip", "gift", "goal", "enter", "leave", "system"}
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        flag = "" if t in valid_types else " ⚠️ 不正"
        print(f"  {t}: {c} 件{flag}")
        if t not in valid_types:
            issues += c

    # 6. user_name NULLチェック（system以外）
    null_user = query(token, "spy_messages",
        f"account_id=eq.{ACCOUNT_ID}&user_name=is.null&msg_type=neq.system"
        f"&select=id,msg_type,message_time"
        f"&order=created_at.desc&limit=10")
    print(f"\n[チェック5] user_name NULL (system以外): {len(null_user)} 件")
    if null_user:
        for m in null_user[:5]:
            print(f"  id={m['id']} type={m['msg_type']} time={m['message_time']}")

    # サマリー
    print("\n" + "=" * 60)
    if issues > 0:
        print(f"⚠️  不正データ {issues} 件検出。cleanup_spy_data.sql の実行を推奨。")
    else:
        print("✅ データ品質OK")
    print("=" * 60)


if __name__ == "__main__":
    main()
