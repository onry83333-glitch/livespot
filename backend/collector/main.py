"""
SPY自動取得パイプライン — メインエントリーポイント

python -m collector.main で起動。デーモンとして常駐し、以下を並行実行:
  1. Poller: 1分毎に全キャストのLIVE状態チェック
  2. WebSocket SPY: 配信中キャストにCentrifugo接続→spy_messagesにリアルタイム蓄積
  3. Viewer Fetcher: 3分毎に視聴者リスト取得→spy_viewers
  4. Payer Fetcher: 1時間毎に課金者リスト取得→paid_users
  5. Thumbnail: 5分毎にサムネイル取得→cast_screenshots
  6. Auth Monitor: 認証エラー時にJWT自動再取得

Telegram通知:
  - 配信開始: 🟢 XXが配信開始しました
  - 配信終了: 🔴 XXの配信終了。視聴者最大N人、収益Ntk
  - エラー:   ⚠️ 認証失敗 / WebSocket切断3回
"""

import asyncio
import logging
import signal
import sys
from datetime import datetime, timezone

from collector.config import get_all_monitored_casts, get_monitored_casts, get_supabase
from collector.session_manager import SessionManager, send_telegram

logger = logging.getLogger("collector")


def setup_logging():
    """ロギング設定"""
    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    console.setLevel(logging.INFO)

    # File
    file_handler = logging.FileHandler(
        "C:/dev/livespot/backend/collector/spy.log",
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.DEBUG)

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.addHandler(console)
    root.addHandler(file_handler)

    # httpx/websocketsの過剰ログを抑制
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("hpack").setLevel(logging.WARNING)


def print_banner():
    """起動バナー表示"""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print("=" * 64)
    print("  SPY Auto-Collection Pipeline")
    print("  Strip Live Spot — Wisteria Creation")
    print(f"  Started: {now}")
    print("=" * 64)


async def preflight_check() -> bool:
    """起動前チェック"""
    errors = []

    # 1. Supabase接続
    try:
        sb = get_supabase()
        res = sb.table("registered_casts").select("cast_name", count="exact").eq("is_active", True).execute()
        cast_count = res.count or len(res.data or [])
        logger.info(f"Supabase接続OK: 監視対象 {cast_count}キャスト")
    except Exception as e:
        errors.append(f"Supabase接続失敗: {e}")

    # 2. Cookie確認
    try:
        from collector.auth import load_cookies_from_file

        cookies = load_cookies_from_file()
        logger.info(f"Cookie OK: {len(cookies)}件")
    except Exception as e:
        errors.append(f"Cookie読み取り失敗: {e}")

    # 3. 監視対象キャスト（自社+他者）
    try:
        casts = get_all_monitored_casts()
        if not casts:
            errors.append("監視対象キャストが0件")
        else:
            own = [c["cast_name"] for c in casts if not c.get("is_spy")]
            spy = [c["cast_name"] for c in casts if c.get("is_spy")]
            logger.info(f"自社キャスト({len(own)}): {own}")
            logger.info(f"他者キャスト({len(spy)}): {spy}")
            if not spy:
                logger.warning(
                    "他者キャスト(SPY)が0件 — spy_castsテーブルにis_active=trueのレコードがあるか確認してください"
                )
    except Exception as e:
        errors.append(f"キャストリスト取得失敗: {e}")

    if errors:
        for err in errors:
            logger.error(f"Preflight FAIL: {err}")
        return False

    logger.info("Preflight OK — 全チェック通過")
    return True


async def main():
    """メインエントリーポイント"""
    setup_logging()
    print_banner()

    # 起動前チェック
    if not await preflight_check():
        logger.error("起動前チェック失敗。終了します。")
        sys.exit(1)

    manager = SessionManager()

    # シグナルハンドラ (graceful shutdown)
    stop_event = asyncio.Event()

    def _signal_handler():
        logger.info("シグナル受信 → graceful shutdown開始")
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            # Windows: signal handlersは使えないのでfallback
            pass

    # 起動通知（自社+他者キャスト統合）
    casts = get_all_monitored_casts()
    own_names = [c["cast_name"] for c in casts if not c.get("is_spy")]
    spy_names = [c["cast_name"] for c in casts if c.get("is_spy")]
    await send_telegram(
        f"🖥️ <b>SPY Pipeline 起動</b>\n"
        f"自社: {len(own_names)}キャスト / 他者SPY: {len(spy_names)}キャスト\n"
        f"自社: {', '.join(own_names[:5])}"
        f"{'...' if len(own_names) > 5 else ''}\n"
        f"SPY: {', '.join(spy_names[:5])}"
        f"{'...' if len(spy_names) > 5 else ''}"
    )

    # メインループ
    manager_task = asyncio.create_task(manager.start())

    try:
        # Windowsではsignal handlerが使えないため、KeyboardInterruptで停止
        await manager_task
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("停止中...")
    finally:
        await manager.stop()
        await send_telegram("🛑 <b>SPY Pipeline 停止</b>")
        logger.info("SPY Pipeline 正常終了")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
