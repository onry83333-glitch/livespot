"""
Collector設定 — 監視対象キャスト・取得頻度・Supabase接続
"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

# backend/.env を読み込み
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

# ---------------------------------------------------------------------------
# Supabase接続
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

_sb_client = None


def get_supabase():
    """Service-roleクライアント（RLSバイパス）をシングルトンで返す"""
    global _sb_client
    if _sb_client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
            raise RuntimeError(
                "SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です。"
                f"backend/.env ({_env_path}) を確認してください。"
            )
        # backend/config.pyのパッチ適用のため、そちら経由でインポート
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from config import get_supabase_admin
        _sb_client = get_supabase_admin()
    return _sb_client


# ---------------------------------------------------------------------------
# Stripchat API
# ---------------------------------------------------------------------------
STRIPCHAT_BASE = "https://stripchat.com"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# ポーリング頻度（秒）
# ---------------------------------------------------------------------------
POLL_INTERVAL = 60          # LIVE状態チェック: 1分
VIEWER_INTERVAL = 180       # 視聴者リスト: 3分
PAYER_INTERVAL = 3600       # 課金者リスト: 1時間
THUMBNAIL_INTERVAL = 300    # サムネイル: 5分

# API呼び出し間の最低待機時間（レート制限対策）
API_CALL_DELAY = 2.0        # 秒

# FC・お気に入りリスト取得
FC_INTERVAL = 21600         # ファンクラブリスト: 6時間
FAVORITE_INTERVAL = 21600   # お気に入りリスト: 6時間

# ---------------------------------------------------------------------------
# WebSocket (Centrifugo)
# ---------------------------------------------------------------------------
WS_URL = "wss://websocket-sp-v6.stripchat.com/connection/websocket"
WS_KEEPALIVE_INTERVAL = 25  # 秒（サーバー側30秒タイムアウト前に送信）
WS_CHANNELS = [
    "newChatMessage",
    "newModelEvent",
    "clearChatMessages",
    "userUpdated",
]

# WebSocket自動再接続（指数バックオフ）
WS_RECONNECT_DELAYS = [5, 10, 30, 60]  # 秒
WS_MAX_CONSECUTIVE_FAILURES = 3         # → Telegramアラート

# レート制限
RATE_LIMIT_429_WAIT = 60    # 429受信時の待機秒数

# ---------------------------------------------------------------------------
# Telegram通知（未設定ならログのみ）
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")


# ---------------------------------------------------------------------------
# 監視対象キャスト取得
# ---------------------------------------------------------------------------
def get_monitored_casts() -> list[dict]:
    """
    Supabase registered_casts から is_active=true のキャストを取得。

    Returns:
        [{"cast_name": "Risa_06", "model_id": 178845750, "account_id": "uuid"}, ...]
    """
    sb = get_supabase()
    res = (
        sb.table("registered_casts")
        .select("cast_name, model_id, stripchat_model_id, account_id, display_name")
        .eq("is_active", True)
        .execute()
    )

    casts = []
    for row in res.data or []:
        # model_id (BIGINT) を優先、なければ stripchat_model_id (TEXT) をフォールバック
        mid = row.get("model_id")
        if not mid and row.get("stripchat_model_id"):
            try:
                mid = int(row["stripchat_model_id"])
            except (ValueError, TypeError):
                mid = None

        casts.append({
            "cast_name": row["cast_name"],
            "model_id": mid,
            "account_id": row["account_id"],
            "display_name": row.get("display_name") or row["cast_name"],
        })

    logger.info(f"監視対象キャスト: {len(casts)}名 ({[c['cast_name'] for c in casts]})")
    return casts
