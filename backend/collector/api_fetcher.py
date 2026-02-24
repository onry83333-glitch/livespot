"""
REST API取得 — 視聴者リスト・課金者リスト をSupabaseに直接INSERT

- 視聴者リスト: /api/front/models/username/{cast}/groupShow/members (JWT/Cookie認証)
- 課金者リスト: /api/front/users/{id}/transactions/users (Cookie認証)
"""

import asyncio
import logging
from datetime import datetime, timezone

import httpx

from collector.auth import build_cookie_header, load_cookies_from_file
from collector.config import (
    API_CALL_DELAY,
    PAYER_INTERVAL,
    STRIPCHAT_BASE,
    USER_AGENT,
    VIEWER_INTERVAL,
    get_monitored_casts,
    get_supabase,
)
from collector.poller import get_cast_session, get_live_casts

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 認証ヘッダー構築
# ---------------------------------------------------------------------------
def _base_headers(cookies: dict[str, str]) -> dict[str, str]:
    return {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Cookie": build_cookie_header(cookies),
    }


def _get_stripchat_jwt(account_id: str) -> str | None:
    """stripchat_sessions から JWT token を取得"""
    try:
        sb = get_supabase()
        res = (
            sb.table("stripchat_sessions")
            .select("jwt_token")
            .eq("account_id", account_id)
            .eq("is_valid", True)
            .limit(1)
            .execute()
        )
        if res.data and res.data[0].get("jwt_token"):
            return res.data[0]["jwt_token"]
    except Exception as e:
        logger.debug(f"JWT取得失敗: {e}")
    return None


def _get_stripchat_user_id(account_id: str) -> str | None:
    """stripchat_sessions から Stripchat user_id を取得"""
    try:
        sb = get_supabase()
        res = (
            sb.table("stripchat_sessions")
            .select("stripchat_user_id")
            .eq("account_id", account_id)
            .eq("is_valid", True)
            .limit(1)
            .execute()
        )
        if res.data and res.data[0].get("stripchat_user_id"):
            return res.data[0]["stripchat_user_id"]
    except Exception as e:
        logger.debug(f"Stripchat user_id取得失敗: {e}")
    return None


# ---------------------------------------------------------------------------
# 視聴者リスト取得
# ---------------------------------------------------------------------------
async def fetch_viewers(
    client: httpx.AsyncClient,
    cast_name: str,
    account_id: str,
    cookies: dict[str, str],
) -> list[dict]:
    """
    /api/front/models/username/{cast}/groupShow/members で視聴者一覧取得。
    JWT認証優先、Cookie認証フォールバック。
    """
    url = f"{STRIPCHAT_BASE}/api/front/models/username/{cast_name}/groupShow/members"

    headers = _base_headers(cookies)

    # JWT優先
    jwt = _get_stripchat_jwt(account_id)
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"

    try:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            logger.warning(f"{cast_name}: viewers API {resp.status_code}")
            return []

        data = resp.json()
        members = data.get("members") or data if isinstance(data, list) else []
        if isinstance(data, dict) and not data.get("members"):
            members = data.get("users", [])

        logger.info(f"{cast_name}: 視聴者 {len(members)}人 取得")
        return members

    except Exception as e:
        logger.error(f"{cast_name}: viewers取得エラー: {e}")
        return []


async def save_viewers(
    cast_name: str,
    account_id: str,
    members: list[dict],
):
    """視聴者リストを spy_viewers にUPSERT"""
    if not members:
        return

    sb = get_supabase()
    session_id = get_cast_session(cast_name)
    now = datetime.now(timezone.utc).isoformat()
    saved = 0

    for m in members:
        user_name = (
            m.get("username")
            or m.get("userName")
            or m.get("name")
            or "unknown"
        )
        user_id = m.get("id") or m.get("userId")
        row = {
            "account_id": account_id,
            "cast_name": cast_name,
            "session_id": session_id,
            "user_name": user_name,
            "user_id_stripchat": str(user_id) if user_id else None,
            "league": m.get("league") or m.get("userLeague"),
            "level": m.get("level") or m.get("userLevel"),
            "is_fan_club": m.get("isFanClub") or m.get("fanClub") or False,
            "last_seen_at": now,
        }

        try:
            # 既存レコードチェック
            query = (
                sb.table("spy_viewers")
                .select("id, visit_count")
                .eq("account_id", account_id)
                .eq("cast_name", cast_name)
                .eq("user_name", user_name)
            )
            if session_id:
                query = query.eq("session_id", session_id)
            else:
                query = query.is_("session_id", "null")

            existing = query.limit(1).execute()

            if existing.data:
                # UPDATE
                sb.table("spy_viewers").update({
                    "last_seen_at": now,
                    "visit_count": existing.data[0]["visit_count"] + 1,
                    "league": row["league"],
                    "level": row["level"],
                }).eq("id", existing.data[0]["id"]).execute()
            else:
                # INSERT
                row["first_seen_at"] = now
                row["visit_count"] = 1
                sb.table("spy_viewers").insert(row).execute()

            saved += 1
        except Exception as e:
            logger.debug(f"spy_viewers upsert失敗 ({user_name}): {e}")

    logger.info(f"{cast_name}: spy_viewers {saved}/{len(members)}件 保存")


# ---------------------------------------------------------------------------
# 課金者リスト取得
# ---------------------------------------------------------------------------
async def fetch_payers(
    client: httpx.AsyncClient,
    account_id: str,
    cookies: dict[str, str],
    max_pages: int = 50,
    limit: int = 100,
) -> list[dict]:
    """
    /api/front/users/{uid}/transactions/users で課金者一覧をページング取得。
    Cookie認証必須。
    """
    user_id = _get_stripchat_user_id(account_id)
    if not user_id:
        logger.warning("課金者リスト: stripchat_user_id が未設定")
        return []

    url_base = f"{STRIPCHAT_BASE}/api/front/users/{user_id}/transactions/users"
    headers = _base_headers(cookies)
    all_users = []
    offset = 0

    for page in range(1, max_pages + 1):
        url = f"{url_base}?offset={offset}&limit={limit}&sort=lastPaid&order=desc"

        try:
            resp = await client.get(url, headers=headers)

            if resp.status_code == 401 or resp.status_code == 403:
                logger.warning(f"課金者API: 認証エラー ({resp.status_code})")
                break
            if resp.status_code == 429:
                logger.warning("課金者API: レート制限。10秒待機。")
                await asyncio.sleep(10)
                continue
            if resp.status_code != 200:
                logger.warning(f"課金者API: HTTP {resp.status_code}")
                break

            data = resp.json()
            users = data.get("transactions", [])

            if not users:
                break

            all_users.extend(users)
            offset += limit

            if page == 1:
                total = data.get("totalCount", "?")
                logger.info(f"課金者リスト: 総数 {total}")

            await asyncio.sleep(API_CALL_DELAY)

        except Exception as e:
            logger.error(f"課金者API取得エラー: {e}")
            break

    logger.info(f"課金者リスト: {len(all_users)}件 取得完了")
    return all_users


async def save_payers(
    account_id: str,
    cast_name: str,
    payers: list[dict],
):
    """課金者リストを paid_users にUPSERT"""
    if not payers:
        return

    sb = get_supabase()
    saved = 0
    batch_size = 500

    for i in range(0, len(payers), batch_size):
        batch = payers[i : i + batch_size]
        rows = []
        for u in batch:
            user_name = u.get("userName")
            if not user_name:
                continue
            rows.append({
                "account_id": account_id,
                "user_name": user_name,
                "total_coins": u.get("totalTokens", 0),
                "last_payment_date": u.get("lastPaid"),
                "user_id_stripchat": str(u["userId"]) if u.get("userId") else None,
                "cast_name": cast_name,
            })

        if rows:
            try:
                sb.table("paid_users").upsert(
                    rows,
                    on_conflict="account_id,user_name",
                ).execute()
                saved += len(rows)
            except Exception as e:
                logger.error(f"paid_users upsert失敗: {e}")

    logger.info(f"paid_users: {saved}/{len(payers)}件 保存 (cast={cast_name})")


# ---------------------------------------------------------------------------
# 定期取得ループ
# ---------------------------------------------------------------------------
async def run_viewer_fetcher():
    """配信中キャストの視聴者リストを3分毎に取得"""
    logger.info("ViewerFetcher起動")

    while True:
        try:
            live_casts = get_live_casts()
            if live_casts:
                cookies = load_cookies_from_file()
                casts = get_monitored_casts()
                cast_map = {c["cast_name"]: c for c in casts}

                async with httpx.AsyncClient(
                    follow_redirects=True, timeout=15.0
                ) as client:
                    for name in live_casts:
                        cast = cast_map.get(name)
                        if not cast:
                            continue

                        members = await fetch_viewers(
                            client, name, cast["account_id"], cookies
                        )
                        await save_viewers(name, cast["account_id"], members)
                        await asyncio.sleep(API_CALL_DELAY)
            else:
                logger.debug("ViewerFetcher: 配信中キャストなし")

        except Exception as e:
            logger.error(f"ViewerFetcherエラー: {e}", exc_info=True)

        await asyncio.sleep(VIEWER_INTERVAL)


async def run_payer_fetcher():
    """課金者リストを1時間毎に取得"""
    logger.info("PayerFetcher起動")

    while True:
        try:
            cookies = load_cookies_from_file()
            casts = get_monitored_casts()

            # account_id 別にグループ化（同一アカウントは1回のみ取得）
            seen_accounts: set[str] = set()

            async with httpx.AsyncClient(
                follow_redirects=True, timeout=30.0
            ) as client:
                for cast in casts:
                    aid = cast["account_id"]
                    if aid in seen_accounts:
                        continue
                    seen_accounts.add(aid)

                    payers = await fetch_payers(client, aid, cookies)
                    # 最初のキャストのcast_nameで保存（同一アカウント内）
                    await save_payers(aid, cast["cast_name"], payers)
                    await asyncio.sleep(API_CALL_DELAY)

        except Exception as e:
            logger.error(f"PayerFetcherエラー: {e}", exc_info=True)

        await asyncio.sleep(PAYER_INTERVAL)


# ---------------------------------------------------------------------------
# CLI実行テスト
# ---------------------------------------------------------------------------
async def _main():
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    print("=" * 60)
    print("API Fetcher Test")
    print("=" * 60)

    cast_name = sys.argv[1] if len(sys.argv) > 1 else "Risa_06"
    cookies = load_cookies_from_file()
    print(f"\n[1] Cookies: {len(cookies)} loaded")
    print(f"[2] Target: {cast_name}")

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        # 視聴者リスト
        print(f"\n[3] Viewer list:")
        members = await fetch_viewers(
            client, cast_name, "00000000-0000-0000-0000-000000000000", cookies
        )
        if members:
            print(f"    {len(members)} viewers found")
            for m in members[:5]:
                name = m.get("username") or m.get("userName") or m.get("name", "?")
                league = m.get("league") or m.get("userLeague", "?")
                print(f"    - {name} (league={league})")
            if len(members) > 5:
                print(f"    ... and {len(members) - 5} more")
        else:
            print("    No viewers (cast may be offline)")

    print(f"\n{'=' * 60}")
    print("API Fetcher test done.")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(_main())
