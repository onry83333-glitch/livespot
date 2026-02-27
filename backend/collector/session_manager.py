"""
セッション管理 — 配信開始検知→WebSocket接続+API取得開始→配信終了→集計+Telegram通知

pollerが検知した配信状態変化に応じて:
- WebSocket SPY接続の開始/終了
- api_fetcher の視聴者/課金者取得をトリガー
- Telegram通知を送信
"""

import asyncio
import logging
from datetime import datetime, timezone

import httpx

from collector.auth import build_cookie_header, load_cookies_from_file
from collector.config import (
    API_CALL_DELAY,
    FC_INTERVAL,
    FAVORITE_INTERVAL,
    PAYER_INTERVAL,
    POLL_INTERVAL,
    STRIPCHAT_BASE,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    THUMBNAIL_INTERVAL,
    USER_AGENT,
    VIEWER_INTERVAL,
    get_all_monitored_casts,
    get_monitored_casts,
    get_supabase,
)
from collector.poller import (
    get_cast_session,
    get_cast_state,
    get_live_casts,
    poll_once,
)
from collector.api_fetcher import (
    fetch_payers,
    fetch_viewers,
    save_payers,
    save_viewers,
)
from collector.websocket_spy import CentrifugoClient, get_centrifugo_jwt

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Telegram通知
# ---------------------------------------------------------------------------
async def send_telegram(message: str):
    """Telegram通知を送信（設定がなければログのみ）"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        logger.info(f"[Telegram] {message}")
        return

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "text": message,
                    "parse_mode": "HTML",
                },
            )
    except Exception as e:
        logger.warning(f"Telegram送信失敗: {e}")


# ---------------------------------------------------------------------------
# サムネイル保存
# ---------------------------------------------------------------------------
async def save_thumbnail(cast_name: str, account_id: str, model_id: int | str | None, session_id: str | None):
    """配信中キャストのサムネイルをcast_screenshotsに保存"""
    if not model_id:
        return

    # Stripchatサムネイル URL (snapshotTimestamp不要、常に最新)
    image_url = f"https://img.strpst.com/thumbs/{model_id}_webp"
    now = datetime.now(timezone.utc).isoformat()

    try:
        sb = get_supabase()
        sb.table("cast_screenshots").insert({
            "account_id": account_id,
            "cast_name": cast_name,
            "model_id": str(model_id),
            "session_id": session_id,
            "captured_at": now,
            "image_url": image_url,
            "thumbnail_type": "spy",
            "is_live": True,
        }).execute()
        logger.debug(f"{cast_name}: サムネイル保存")
    except Exception as e:
        logger.debug(f"{cast_name}: サムネイル保存失敗: {e}")


# ---------------------------------------------------------------------------
# SessionManager: 全キャストのライフサイクル統合管理
# ---------------------------------------------------------------------------
class SessionManager:
    """
    配信ライフサイクルを管理するメインオーケストレータ。

    - pollerからの状態変化を検知
    - 配信開始時: WebSocket接続 + API取得開始
    - 配信中: 定期的にviewer/payer/thumbnail取得
    - 配信終了時: 集計 + Telegram通知
    """

    def __init__(self):
        self._ws_clients: dict[str, CentrifugoClient] = {}
        self._running = False
        self._jwt_token = ""
        self._cf_clearance = ""
        self._auth_error_event = asyncio.Event()
        self._prev_live: set[str] = set()

        # 定期取得の最終実行時刻
        self._last_viewer_fetch: dict[str, float] = {}
        self._last_payer_fetch: dict[str, float] = {}
        self._last_thumbnail_fetch: dict[str, float] = {}
        self._last_fc_fetch: dict[str, float] = {}
        self._last_fav_fetch: dict[str, float] = {}

    async def start(self):
        """全コンポーネントを起動"""
        self._running = True
        logger.info("SessionManager 起動")

        # JWT取得
        await self._refresh_jwt()

        # 並行タスク起動
        tasks = [
            asyncio.create_task(self._poll_loop(), name="poller"),
            asyncio.create_task(self._viewer_loop(), name="viewer_fetcher"),
            asyncio.create_task(self._payer_loop(), name="payer_fetcher"),
            asyncio.create_task(self._thumbnail_loop(), name="thumbnail"),
            asyncio.create_task(self._auth_monitor(), name="auth_monitor"),
        ]

        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()

    async def stop(self):
        """全WebSocket接続をクリーンアップ"""
        self._running = False
        for name, ws_client in list(self._ws_clients.items()):
            logger.info(f"{name}: WS切断中...")
            await ws_client.disconnect()
        self._ws_clients.clear()
        logger.info("SessionManager 停止")

    # ---------------------------------------------------------------------------
    # JWT管理
    # ---------------------------------------------------------------------------
    async def _refresh_jwt(self):
        """CentrifugoのJWTを取得/更新"""
        try:
            jwt, cf = await get_centrifugo_jwt()
            if jwt:
                self._jwt_token = jwt
                if cf:
                    self._cf_clearance = cf
                logger.info("Centrifugo JWT更新完了")
                # 全既存WS接続にも反映
                for ws_client in self._ws_clients.values():
                    ws_client.update_auth(self._jwt_token, self._cf_clearance)
            else:
                logger.warning("Centrifugo JWT取得失敗")
        except Exception as e:
            logger.error(f"JWT更新エラー: {e}")

    async def _auth_monitor(self):
        """認証エラーイベントを監視し、JWT再取得を行う"""
        while self._running:
            await self._auth_error_event.wait()
            self._auth_error_event.clear()
            logger.warning("認証エラー検知 → JWT再取得")
            await send_telegram("⚠️ WebSocket認証エラー → JWT再取得中")
            await self._refresh_jwt()
            await asyncio.sleep(5)

    # ---------------------------------------------------------------------------
    # ポーリングループ（1分毎）
    # ---------------------------------------------------------------------------
    async def _poll_loop(self):
        """1分毎にキャスト状態をポーリングし、状態変化に応じてWS管理（自社+他者キャスト統合）"""
        logger.info("Poller起動")
        casts = get_all_monitored_casts()

        while self._running:
            try:
                if not casts:
                    casts = get_all_monitored_casts()

                if not casts:
                    logger.warning("監視対象キャストなし。60秒後にリトライ。")
                    await asyncio.sleep(POLL_INTERVAL)
                    continue

                results = await poll_once(casts)
                cast_map = {c["cast_name"]: c for c in casts}

                current_live = set(get_live_casts())
                new_live = current_live - self._prev_live
                went_offline = self._prev_live - current_live

                # 新規配信開始
                for name in new_live:
                    cast = cast_map.get(name)
                    if cast:
                        await self._on_stream_start(cast)

                # 配信終了
                for name in went_offline:
                    cast = cast_map.get(name)
                    if cast:
                        await self._on_stream_end(cast)

                self._prev_live = current_live

                live_count = len(current_live)
                off_count = len([s for s in results.values() if s != "public" and s != "error"])
                err_count = len([s for s in results.values() if s == "error"])
                logger.info(
                    f"Poll完了: LIVE={list(current_live) or '-'}, "
                    f"OFF={off_count}, ERR={err_count}, "
                    f"WS={len(self._ws_clients)}"
                )

                # 10分毎にキャストリスト更新（自社+他者キャスト統合）
                casts = get_all_monitored_casts()

            except Exception as e:
                logger.error(f"Pollerエラー: {e}", exc_info=True)

            await asyncio.sleep(POLL_INTERVAL)

    async def _on_stream_start(self, cast: dict):
        """配信開始: WebSocket接続 + Telegram通知"""
        name = cast["cast_name"]
        state = get_cast_state(name)
        session_id = state.get("session_id")
        model_id = state.get("model_id") or cast.get("model_id")
        display = cast.get("display_name", name)

        logger.info(f"{name}: 配信開始 → WS接続開始")

        # Telegram
        await send_telegram(f"🟢 <b>{display}</b> が配信開始しました")

        # WebSocket接続
        if model_id:
            ws_client = CentrifugoClient(
                cast_name=name,
                model_id=model_id,
                account_id=cast["account_id"],
                session_id=session_id,
                jwt_token=self._jwt_token,
                cf_clearance=self._cf_clearance,
                on_auth_error=self._auth_error_event,
            )
            self._ws_clients[name] = ws_client
            await ws_client.connect()
        else:
            logger.warning(f"{name}: model_id不明 → WS接続スキップ")

    async def _on_stream_end(self, cast: dict):
        """配信終了: WS切断 + 集計 + Telegram通知"""
        name = cast["cast_name"]
        display = cast.get("display_name", name)

        # WS統計取得 & 切断
        ws_client = self._ws_clients.pop(name, None)
        ws_msgs = 0
        ws_tips = 0
        if ws_client:
            ws_msgs = ws_client.message_count
            ws_tips = ws_client.tip_total
            await ws_client.disconnect()

        # pollerからの状態でpeak_viewers取得
        state = get_cast_state(name)
        peak = state.get("peak_viewers", 0)
        session_id = state.get("session_id")

        # セッション時間算出
        duration_min = 0
        if state.get("started_at"):
            try:
                start = datetime.fromisoformat(state["started_at"])
                duration_min = int(
                    (datetime.now(timezone.utc) - start).total_seconds() / 60
                )
            except (ValueError, TypeError):
                pass

        logger.info(
            f"{name}: 配信終了 "
            f"({duration_min}分, msgs={ws_msgs}, tips={ws_tips}tk, peak={peak})"
        )

        # Telegram通知
        await send_telegram(
            f"🔴 <b>{display}</b> の配信終了\n"
            f"⏱ {duration_min}分 / 💬 {ws_msgs}メッセージ / "
            f"👥 最大{peak}人 / 💰 {ws_tips}tk"
        )

        # タイマーリセット
        self._last_viewer_fetch.pop(name, None)
        self._last_thumbnail_fetch.pop(name, None)

    # ---------------------------------------------------------------------------
    # 視聴者リスト取得ループ（3分毎）
    # ---------------------------------------------------------------------------
    async def _viewer_loop(self):
        """配信中キャストの視聴者リストを3分毎に取得"""
        logger.info("ViewerFetcher起動")

        while self._running:
            try:
                live_casts = get_live_casts()
                if live_casts:
                    cookies = load_cookies_from_file()
                    all_casts = get_all_monitored_casts()
                    cast_map = {c["cast_name"]: c for c in all_casts}
                    now = asyncio.get_event_loop().time()

                    async with httpx.AsyncClient(
                        follow_redirects=True, timeout=15.0
                    ) as client:
                        for name in live_casts:
                            last = self._last_viewer_fetch.get(name, 0)
                            if now - last < VIEWER_INTERVAL:
                                continue

                            cast = cast_map.get(name)
                            if not cast:
                                continue

                            members = await fetch_viewers(
                                client, name, cast["account_id"], cookies
                            )
                            await save_viewers(name, cast["account_id"], members)
                            self._last_viewer_fetch[name] = now
                            await asyncio.sleep(API_CALL_DELAY)

            except Exception as e:
                logger.error(f"ViewerFetcherエラー: {e}", exc_info=True)

            await asyncio.sleep(30)  # 30秒毎にチェック

    # ---------------------------------------------------------------------------
    # 課金者リスト取得ループ（1時間毎）
    # ---------------------------------------------------------------------------
    async def _payer_loop(self):
        """課金者リストを1時間毎に取得"""
        logger.info("PayerFetcher起動")

        while self._running:
            try:
                cookies = load_cookies_from_file()
                casts = get_monitored_casts()
                now = asyncio.get_event_loop().time()

                seen_accounts: set[str] = set()
                async with httpx.AsyncClient(
                    follow_redirects=True, timeout=30.0
                ) as client:
                    for cast in casts:
                        aid = cast["account_id"]
                        if aid in seen_accounts:
                            continue

                        last = self._last_payer_fetch.get(aid, 0)
                        if now - last < PAYER_INTERVAL:
                            continue

                        seen_accounts.add(aid)
                        payers = await fetch_payers(client, aid, cookies)
                        await save_payers(aid, cast["cast_name"], payers)
                        self._last_payer_fetch[aid] = now
                        await asyncio.sleep(API_CALL_DELAY)

            except Exception as e:
                logger.error(f"PayerFetcherエラー: {e}", exc_info=True)

            await asyncio.sleep(60)  # 1分毎にチェック

    # ---------------------------------------------------------------------------
    # サムネイル取得ループ（5分毎）
    # ---------------------------------------------------------------------------
    async def _thumbnail_loop(self):
        """配信中キャストのサムネイルを5分毎に保存"""
        logger.info("ThumbnailFetcher起動")

        while self._running:
            try:
                live_casts = get_live_casts()
                if live_casts:
                    all_casts = get_all_monitored_casts()
                    cast_map = {c["cast_name"]: c for c in all_casts}
                    now = asyncio.get_event_loop().time()

                    for name in live_casts:
                        last = self._last_thumbnail_fetch.get(name, 0)
                        if now - last < THUMBNAIL_INTERVAL:
                            continue

                        cast = cast_map.get(name)
                        if not cast:
                            continue

                        state = get_cast_state(name)
                        model_id = state.get("model_id") or cast.get("model_id")
                        session_id = state.get("session_id")

                        await save_thumbnail(
                            name, cast["account_id"], model_id, session_id
                        )
                        self._last_thumbnail_fetch[name] = now

            except Exception as e:
                logger.error(f"ThumbnailFetcherエラー: {e}", exc_info=True)

            await asyncio.sleep(60)
