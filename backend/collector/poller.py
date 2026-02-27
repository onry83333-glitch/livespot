"""
LIVE状態ポーリング — 1分毎に全監視対象キャストの配信状態をチェック

- status: "public" → 配信開始検知 → セッション作成 + Telegram通知
- status: "off" / "private" / etc → 配信終了検知 → セッション終了 + 集計
"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone

import httpx

from collector.auth import build_cookie_header, load_cookies_from_file
from collector.config import (
    API_CALL_DELAY,
    POLL_INTERVAL,
    STRIPCHAT_BASE,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    USER_AGENT,
    get_monitored_casts,
    get_supabase,
)

logger = logging.getLogger(__name__)

# キャスト別の現在の状態
# cast_name → {"status": str, "session_id": str|None, "started_at": str|None,
#              "model_id": int|None, "viewers": int}
_cast_state: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Stripchat API: キャスト状態取得
# ---------------------------------------------------------------------------
async def fetch_cast_status(
    client: httpx.AsyncClient,
    cast_name: str,
    cookies: dict[str, str],
) -> dict | None:
    """
    /api/front/v2/models/username/{name}/cam を叩いてキャスト状態を返す。

    Returns:
        {"status": "public"|"off"|..., "model_id": int, "viewers": int,
         "snapshot_ts": int|None} or None on error
    """
    url = f"{STRIPCHAT_BASE}/api/front/v2/models/username/{cast_name}/cam"
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Cookie": build_cookie_header(cookies),
    }

    try:
        resp = await client.get(url, headers=headers)
        if resp.status_code == 404:
            logger.debug(f"{cast_name}: 404 (アカウント削除/名前変更?)")
            return None
        if resp.status_code != 200:
            logger.warning(f"{cast_name}: HTTP {resp.status_code}")
            return None

        data = resp.json()
        inner = data.get("user", {}).get("user", {})
        return {
            "status": inner.get("status", "unknown"),
            "model_id": inner.get("id"),
            "viewers": inner.get("viewersCount", 0),
            "snapshot_ts": inner.get("snapshotTimestamp"),
        }
    except Exception as e:
        logger.error(f"{cast_name}: 状態取得エラー: {e}")
        return None


# ---------------------------------------------------------------------------
# Telegram通知
# ---------------------------------------------------------------------------
async def send_telegram(client: httpx.AsyncClient, message: str):
    """Telegram通知を送信（設定がなければログのみ）"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        logger.info(f"[Telegram] {message}")
        return

    try:
        await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Telegram送信失敗: {e}")


# ---------------------------------------------------------------------------
# セッション管理
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def on_stream_start(
    client: httpx.AsyncClient,
    cast: dict,
    info: dict,
):
    """配信開始検知時の処理"""
    cast_name = cast["cast_name"]
    session_id = str(uuid.uuid4())
    now = _now_iso()

    _cast_state[cast_name] = {
        "status": "public",
        "session_id": session_id,
        "started_at": now,
        "model_id": info.get("model_id"),
        "viewers": info.get("viewers", 0),
        "peak_viewers": info.get("viewers", 0),
    }

    # Supabaseにセッション作成
    try:
        sb = get_supabase()
        sb.table("sessions").insert({
            "account_id": cast["account_id"],
            "session_id": session_id,
            "cast_name": cast_name,
            "started_at": now,
        }).execute()
        logger.info(f"{cast_name}: セッション開始 (session={session_id[:8]})")
    except Exception as e:
        logger.error(f"{cast_name}: セッション作成失敗: {e}")

    # model_id を registered_casts に保存（未設定時）
    if info.get("model_id") and not cast.get("model_id"):
        try:
            sb = get_supabase()
            sb.table("registered_casts").update({
                "model_id": info["model_id"],
            }).eq("cast_name", cast_name).eq(
                "account_id", cast["account_id"]
            ).execute()
            cast["model_id"] = info["model_id"]
            logger.info(f"{cast_name}: model_id={info['model_id']} 保存")
        except Exception as e:
            logger.warning(f"{cast_name}: model_id保存失敗: {e}")

    # Telegram通知
    display = cast.get("display_name", cast_name)
    await send_telegram(
        client,
        f"<b>{display}</b> が配信開始しました",
    )


async def on_stream_end(
    client: httpx.AsyncClient,
    cast: dict,
):
    """配信終了検知時の処理"""
    cast_name = cast["cast_name"]
    state = _cast_state.get(cast_name, {})
    session_id = state.get("session_id")
    now = _now_iso()

    if session_id:
        # Supabaseでセッション終了
        try:
            sb = get_supabase()

            # spy_messages からセッション集計
            msg_stats = (
                sb.table("spy_messages")
                .select("id", count="exact")
                .eq("session_id", session_id)
                .execute()
            )
            total_messages = msg_stats.count or 0

            token_res = sb.rpc("daily_sales", {
                "p_account_id": cast["account_id"],
                "p_since": state.get("started_at", now),
                "p_cast_name": cast_name,
            }).execute()

            sb.table("sessions").update({
                "ended_at": now,
                "total_messages": total_messages,
                "peak_viewers": state.get("peak_viewers", 0),
            }).eq("session_id", session_id).execute()

            duration_min = 0
            if state.get("started_at"):
                try:
                    start = datetime.fromisoformat(state["started_at"])
                    end = datetime.now(timezone.utc)
                    duration_min = int((end - start).total_seconds() / 60)
                except (ValueError, TypeError):
                    pass

            logger.info(
                f"{cast_name}: セッション終了 "
                f"(session={session_id[:8]}, {duration_min}分, "
                f"msgs={total_messages}, peak={state.get('peak_viewers', 0)})"
            )

            # Telegram通知
            display = cast.get("display_name", cast_name)
            await send_telegram(
                client,
                f"<b>{display}</b> の配信終了\n"
                f"時間: {duration_min}分 / メッセージ: {total_messages} / "
                f"最大視聴者: {state.get('peak_viewers', 0)}",
            )

        except Exception as e:
            logger.error(f"{cast_name}: セッション終了処理失敗: {e}")

    # 状態リセット
    _cast_state[cast_name] = {
        "status": "off",
        "session_id": None,
        "started_at": None,
        "model_id": state.get("model_id"),
        "viewers": 0,
        "peak_viewers": 0,
    }


# ---------------------------------------------------------------------------
# ポーリング1サイクル
# ---------------------------------------------------------------------------
async def poll_once(casts: list[dict]) -> dict[str, str]:
    """
    全監視対象キャストのLIVE状態を1回チェック。

    Returns:
        {"cast_name": "public"|"off"|..., ...}
    """
    cookies = load_cookies_from_file()
    results = {}

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        for cast in casts:
            name = cast["cast_name"]
            info = await fetch_cast_status(client, name, cookies)

            if info is None:
                results[name] = "error"
                await asyncio.sleep(API_CALL_DELAY)
                continue

            new_status = info["status"]
            prev_state = _cast_state.get(name, {})
            prev_status = prev_state.get("status", "unknown")
            results[name] = new_status

            # 配信開始検知: off/unknown → public
            if new_status == "public" and prev_status != "public":
                await on_stream_start(client, cast, info)

            # 配信終了検知: public → off/private/etc
            elif new_status != "public" and prev_status == "public":
                await on_stream_end(client, cast)

            # 配信中: ピーク視聴者数更新
            elif new_status == "public":
                viewers = info.get("viewers", 0)
                if name in _cast_state:
                    current_peak = _cast_state[name].get("peak_viewers", 0)
                    if viewers > current_peak:
                        _cast_state[name]["peak_viewers"] = viewers
                    _cast_state[name]["viewers"] = viewers

            # 状態が変わらない場合もステータスは記録
            if name not in _cast_state:
                _cast_state[name] = {
                    "status": new_status,
                    "session_id": None,
                    "started_at": None,
                    "model_id": info.get("model_id"),
                    "viewers": info.get("viewers", 0),
                    "peak_viewers": 0,
                }

            await asyncio.sleep(API_CALL_DELAY)

    return results


# ---------------------------------------------------------------------------
# ポーリングループ
# ---------------------------------------------------------------------------
async def run_poller():
    """1分毎のポーリングを無限ループで実行"""
    logger.info("Poller起動")

    while True:
        try:
            casts = get_monitored_casts()
            if not casts:
                logger.warning("監視対象キャストがありません。60秒後にリトライ。")
                await asyncio.sleep(POLL_INTERVAL)
                continue

            results = await poll_once(casts)

            live = [n for n, s in results.items() if s == "public"]
            off = [n for n, s in results.items() if s != "public" and s != "error"]
            errors = [n for n, s in results.items() if s == "error"]

            logger.info(
                f"Poll完了: LIVE={live or '-'}, OFF={len(off)}, ERR={len(errors)}"
            )

        except Exception as e:
            logger.error(f"Pollerエラー: {e}", exc_info=True)

        await asyncio.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# 現在のキャスト状態を取得（他モジュールから参照用）
# ---------------------------------------------------------------------------
def get_live_casts() -> list[str]:
    """現在配信中のキャスト名リストを返す"""
    return [name for name, s in _cast_state.items() if s.get("status") == "public"]


def get_cast_session(cast_name: str) -> str | None:
    """キャストの現在のsession_idを返す"""
    return _cast_state.get(cast_name, {}).get("session_id")


def get_cast_state(cast_name: str) -> dict:
    """キャストの現在の状態を返す"""
    return _cast_state.get(cast_name, {})


# ---------------------------------------------------------------------------
# CLI実行用
# ---------------------------------------------------------------------------
async def _main():
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    print("=" * 60)
    print("Poller Test - LIVE status check")
    print("=" * 60)

    # テスト: 単発ポーリング
    # Supabase未接続でもテストできるようにハードコードキャストを使用
    test_casts = [
        {"cast_name": "Risa_06", "model_id": 178845750,
         "account_id": "00000000-0000-0000-0000-000000000000",
         "display_name": "Risa_06"},
    ]

    # 引数があればそれもテスト対象に追加
    for arg in sys.argv[1:]:
        test_casts.append({
            "cast_name": arg,
            "model_id": None,
            "account_id": "00000000-0000-0000-0000-000000000000",
            "display_name": arg,
        })

    cookies = load_cookies_from_file()
    print(f"\n[1] Cookies: {len(cookies)} loaded")

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        for cast in test_casts:
            name = cast["cast_name"]
            info = await fetch_cast_status(client, name, cookies)
            if info:
                print(f"\n[OK] {name}:")
                print(f"    status:   {info['status']}")
                print(f"    model_id: {info['model_id']}")
                print(f"    viewers:  {info['viewers']}")
            else:
                print(f"\n[FAIL] {name}: could not fetch status")

            await asyncio.sleep(API_CALL_DELAY)

    print(f"\n{'=' * 60}")
    print("Poller test done.")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(_main())
