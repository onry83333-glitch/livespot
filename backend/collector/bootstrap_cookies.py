"""
cookies.json 初回生成スクリプト

2つのモード:
  A) --paste: Chrome拡張のdevtoolsからコピペで貼り付け
  B) --supabase: Supabaseのstripchat_sessionsテーブルから取得

使い方:
  cd C:\dev\livespot\backend

  # モードA: Chrome拡張のService Workerコンソールで以下を実行 → 出力をコピー
  #   chrome.cookies.getAll({domain:".stripchat.com"},c=>console.log(JSON.stringify(Object.fromEntries(c.map(x=>[x.name,x.value])))))
  # → このスクリプトに貼り付け:
  python -m collector.bootstrap_cookies --paste

  # モードB: .envにSupabase設定がある場合
  python -m collector.bootstrap_cookies --supabase
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

COOKIE_FILE = Path(__file__).parent / "cookies.json"


def save_cookies(cookies: dict, source: str):
    payload = {
        "cookies": cookies,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[OK] {len(cookies)} cookies -> {COOKIE_FILE}")


def mode_paste():
    """Chrome devtools出力を貼り付けて cookies.json を生成"""
    print("Chrome拡張のService Workerコンソールで以下を実行:")
    print()
    print('  chrome.cookies.getAll({domain:".stripchat.com"},c=>console.log(JSON.stringify(Object.fromEntries(c.map(x=>[x.name,x.value])))))')
    print()
    print("出力されたJSON文字列を貼り付けてEnter:")
    print()

    raw = input("> ").strip()
    if not raw:
        print("[FAIL] Empty input")
        sys.exit(1)

    try:
        cookies = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[FAIL] Invalid JSON: {e}")
        sys.exit(1)

    if not isinstance(cookies, dict) or not cookies:
        print("[FAIL] Expected non-empty JSON object")
        sys.exit(1)

    save_cookies(cookies, "manual_paste")
    print(f"\nNext: python -m collector.auth")


def mode_supabase():
    """Supabase stripchat_sessions から取得"""
    from dotenv import load_dotenv

    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("[FAIL] SUPABASE_URL or SUPABASE_SERVICE_KEY not set")
        print(f"       .env path: {env_path} (exists={env_path.exists()})")
        sys.exit(1)

    import httpx

    r = httpx.get(
        f"{url}/rest/v1/stripchat_sessions"
        "?is_valid=eq.true"
        "&select=cookies_json,updated_at"
        "&order=updated_at.desc"
        "&limit=1",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
        },
        timeout=10,
    )

    if r.status_code != 200:
        print(f"[FAIL] Supabase error: {r.status_code} {r.text[:200]}")
        sys.exit(1)

    data = r.json()
    if not data or not data[0].get("cookies_json"):
        print("[FAIL] No valid session in stripchat_sessions")
        sys.exit(1)

    row = data[0]
    save_cookies(row["cookies_json"], "supabase_bootstrap")
    print(f"     updated_at: {row['updated_at']}")
    print(f"\nNext: python -m collector.auth")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("--paste", "--supabase"):
        print("Usage:")
        print("  python -m collector.bootstrap_cookies --paste     # Chrome devtoolsから貼り付け")
        print("  python -m collector.bootstrap_cookies --supabase  # Supabaseから取得")
        sys.exit(1)

    if sys.argv[1] == "--paste":
        mode_paste()
    else:
        mode_supabase()


if __name__ == "__main__":
    main()
