"""
WebSocket SPY — Centrifugo v3 プロトコルでStripchatのリアルタイムデータを取得

- wss://websocket-sp-v6.stripchat.com/connection/websocket に接続
- チャンネル: newChatMessage / newModelEvent / clearChatMessages / userUpdated
- チャット・ギフト・入退室イベントを spy_messages にリアルタイム蓄積
- 自動再接続: 5s→10s→30s→60s 指数バックオフ
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx

from collector.config import (
    USER_AGENT,
    WS_CHANNELS,
    WS_KEEPALIVE_INTERVAL,
    WS_MAX_CONSECUTIVE_FAILURES,
    WS_RECONNECT_DELAYS,
    WS_URL,
    get_supabase,
)

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _split_frames(text: str) -> list[dict]:
    """
    Centrifugoは1フレームに複数JSONオブジェクトを結合して送る。
    {"id":1,...}{"id":2,...} → [dict, dict] に分割。
    """
    results = []
    for line in text.split("\n"):
        depth = 0
        start = 0
        for i, ch in enumerate(line):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    part = line[start : i + 1].strip()
                    start = i + 1
                    if part:
                        try:
                            results.append(json.loads(part))
                        except json.JSONDecodeError:
                            pass
    return results


def _parse_chat_message(data: dict) -> dict | None:
    """
    Centrifugo newChatMessage の data オブジェクトをパース。

    構造:
      data.message.userData.username
      data.message.details.body
      data.message.details.amount (tip)
      data.message.type ("text"|"tip")
      data.message.createdAt
      data.message.userData.userRanking.league / .level
      data.message.userData.isModel
      data.message.additionalData.isKing / isKnight
    """
    m = data.get("message")
    if not m or not isinstance(m, dict):
        return None

    user_data = m.get("userData") or {}
    details = m.get("details") or {}
    ranking = user_data.get("userRanking") or {}
    additional = m.get("additionalData") or {}

    user_name = (
        user_data.get("username")
        or user_data.get("screenName")
        or data.get("username")
        or ""
    )
    if not user_name:
        return None

    message = details.get("body") or details.get("text") or ""
    tokens = _safe_int(details.get("amount")) or _safe_int(data.get("tokens")) or 0
    raw_type = m.get("type", "")
    msg_type = "tip" if (raw_type == "tip" or tokens > 0) else "chat"
    message_time = m.get("createdAt") or _now_iso()

    user_league = str(ranking.get("league", ""))
    user_level = _safe_int(ranking.get("level"))
    is_model = user_data.get("isModel") is True
    is_king = additional.get("isKing") is True
    is_knight = additional.get("isKnight") is True
    user_id = str(user_data.get("id", ""))

    fan_months = _safe_int(details.get("fanClubNumberMonthsOfSubscribed"))
    is_fan_club = fan_months > 0 or user_data.get("isFanClubMember") is True

    is_vip = tokens >= 1000 or is_king or is_knight

    return {
        "user_name": user_name,
        "message": message,
        "tokens": tokens,
        "msg_type": msg_type,
        "message_time": message_time,
        "user_league": user_league,
        "user_level": user_level,
        "is_model": is_model,
        "is_king": is_king,
        "is_knight": is_knight,
        "is_fan_club": is_fan_club,
        "is_vip": is_vip,
        "user_id_stripchat": user_id,
    }


def _safe_int(v) -> int:
    if v is None:
        return 0
    if isinstance(v, int):
        return v
    if isinstance(v, (str, float)):
        try:
            return int(v)
        except (ValueError, TypeError):
            return 0
    return 0


class CentrifugoClient:
    """
    1キャスト分のCentrifugo WebSocket接続を管理。

    - JWT認証でconnect
    - 4チャンネル (newChatMessage等) にsubscribe
    - 25秒keepalive
    - 自動再接続 (指数バックオフ)
    """

    def __init__(
        self,
        cast_name: str,
        model_id: int | str,
        account_id: str,
        session_id: str | None,
        jwt_token: str,
        cf_clearance: str,
        on_auth_error: asyncio.Event | None = None,
    ):
        self.cast_name = cast_name
        self.model_id = str(model_id)
        self.account_id = account_id
        self.session_id = session_id
        self.jwt_token = jwt_token
        self.cf_clearance = cf_clearance
        self.on_auth_error = on_auth_error

        self._ws = None
        self._connected = False
        self._msg_id = 0
        self._keepalive_task: asyncio.Task | None = None
        self._receive_task: asyncio.Task | None = None
        self._running = False
        self._consecutive_failures = 0

        # 統計
        self.message_count = 0
        self.tip_total = 0

        # メッセージバッファ（バッチINSERT用）
        self._buffer: list[dict] = []
        self._flush_task: asyncio.Task | None = None

    @property
    def is_connected(self) -> bool:
        return self._connected and self._ws is not None

    def update_session(self, session_id: str | None):
        self.session_id = session_id

    def update_auth(self, jwt_token: str, cf_clearance: str):
        self.jwt_token = jwt_token
        self.cf_clearance = cf_clearance

    async def connect(self):
        """WebSocket接続を開始し、バックグラウンドタスクを起動"""
        if self._running:
            return
        self._running = True
        self._consecutive_failures = 0
        self._receive_task = asyncio.create_task(self._connection_loop())
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def disconnect(self):
        """切断してバックグラウンドタスクをクリーンアップ"""
        self._running = False
        if self._keepalive_task and not self._keepalive_task.done():
            self._keepalive_task.cancel()
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()
        await self._close_ws()
        # 残バッファをフラッシュ
        await self._flush_buffer()
        logger.info(f"{self.cast_name}: WS disconnected (msgs={self.message_count}, tips={self.tip_total}tk)")

    async def _close_ws(self):
        self._connected = False
        if self._ws:
            try:
                await self._ws.aclose()
            except Exception:
                pass
            self._ws = None

    async def _connection_loop(self):
        """自動再接続付きの接続ループ"""
        while self._running:
            try:
                await self._single_connection()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"{self.cast_name}: WS接続エラー: {e}")

            if not self._running:
                break

            self._consecutive_failures += 1
            if self._consecutive_failures >= WS_MAX_CONSECUTIVE_FAILURES:
                logger.error(
                    f"{self.cast_name}: WS {self._consecutive_failures}回連続失敗"
                )
                if self.on_auth_error:
                    self.on_auth_error.set()

            # 指数バックオフ
            delay_idx = min(self._consecutive_failures - 1, len(WS_RECONNECT_DELAYS) - 1)
            delay = WS_RECONNECT_DELAYS[max(0, delay_idx)]
            logger.info(f"{self.cast_name}: {delay}秒後に再接続...")
            await asyncio.sleep(delay)

    async def _single_connection(self):
        """1回分のWebSocket接続ライフサイクル"""
        import websockets
        from websockets.asyncio.client import connect

        headers = {
            "User-Agent": USER_AGENT,
            "Origin": "https://stripchat.com",
            "Accept-Language": "ja,en-US;q=0.9",
        }
        if self.cf_clearance:
            headers["Cookie"] = f"cf_clearance={self.cf_clearance}"

        logger.info(
            f"{self.cast_name}: WS接続中 (model={self.model_id}, "
            f"auth={'yes' if self.jwt_token else 'no'})"
        )

        async with connect(
            WS_URL,
            additional_headers=headers,
            ping_interval=None,  # 自前でkeepalive管理
            close_timeout=5,
        ) as ws:
            self._ws = ws

            # Centrifugo connect コマンド送信
            self._msg_id += 1
            connect_cmd = json.dumps({
                "connect": {"token": self.jwt_token, "name": "js"},
                "id": self._msg_id,
            })
            await ws.send(connect_cmd)

            # 最初のメッセージ = connect応答
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
            except asyncio.TimeoutError:
                logger.warning(f"{self.cast_name}: connect応答タイムアウト")
                return

            text = raw if isinstance(raw, str) else raw.decode()
            frames = _split_frames(text.strip())

            connected = False
            for frame in frames:
                if frame.get("error"):
                    code = frame["error"].get("code", 0)
                    msg = frame["error"].get("message", "")
                    logger.error(f"{self.cast_name}: CONNECT ERR code={code} {msg}")
                    if code == 3501 and self.on_auth_error:
                        self.on_auth_error.set()
                    return
                if frame.get("connect"):
                    client_id = frame["connect"].get("client", "")
                    logger.info(f"{self.cast_name}: CONNECT OK client={client_id}")
                    connected = True

            if not connected:
                logger.warning(f"{self.cast_name}: connect応答なし")
                return

            self._connected = True
            self._consecutive_failures = 0

            # チャンネル購読
            for ch_name in WS_CHANNELS:
                channel = f"{ch_name}@{self.model_id}"
                self._msg_id += 1
                sub_cmd = json.dumps({
                    "subscribe": {"channel": channel},
                    "id": self._msg_id,
                })
                await ws.send(sub_cmd)
                logger.debug(f"{self.cast_name}: SUB → {channel}")

            # keepalive起動
            self._keepalive_task = asyncio.create_task(self._keepalive(ws))

            # メッセージ受信ループ
            try:
                async for raw_msg in ws:
                    text = raw_msg if isinstance(raw_msg, str) else raw_msg.decode()
                    text = text.strip()

                    # サーバーping → pong
                    if text == "{}":
                        await ws.send("{}")
                        continue

                    frames = _split_frames(text)
                    for frame in frames:
                        self._handle_frame(frame)

            except websockets.exceptions.ConnectionClosed as e:
                logger.info(f"{self.cast_name}: WS closed code={e.code}")
                if e.code == 3501 and self.on_auth_error:
                    self.on_auth_error.set()
            finally:
                self._connected = False
                if self._keepalive_task and not self._keepalive_task.done():
                    self._keepalive_task.cancel()

    async def _keepalive(self, ws):
        """25秒間隔でkeepalive送信"""
        from websockets.protocol import State

        try:
            while self._running:
                await asyncio.sleep(WS_KEEPALIVE_INTERVAL)
                if ws.state == State.OPEN:
                    await ws.send("{}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"{self.cast_name}: keepaliveエラー: {e}")

    def _handle_frame(self, frame: dict):
        """受信フレーム1つを処理"""
        # Subscribe確認
        if frame.get("id") and frame.get("subscribe"):
            logger.debug(f"{self.cast_name}: SUB OK id={frame['id']}")
            return

        # Subscribe/その他エラー
        if frame.get("id") and frame.get("error"):
            logger.warning(
                f"{self.cast_name}: FRAME ERR id={frame['id']} "
                f"code={frame['error'].get('code')} {frame['error'].get('message')}"
            )
            return

        # Push message
        push = frame.get("push")
        if not push:
            return

        channel = push.get("channel", "")
        pub_data = (push.get("pub") or {}).get("data")
        if not pub_data:
            return

        event = channel.split("@")[0]

        if event == "newChatMessage":
            self._on_chat(pub_data)
        elif event == "newModelEvent":
            self._on_model_event(pub_data)
        elif event == "userUpdated":
            logger.debug(f"{self.cast_name}: USER_UPDATED")

    def _on_chat(self, data: dict):
        """チャット/チップメッセージを処理"""
        parsed = _parse_chat_message(data)
        if not parsed:
            return

        self.message_count += 1
        if parsed["tokens"] > 0:
            self.tip_total += parsed["tokens"]
            logger.info(
                f"{self.cast_name}: TIP {parsed['user_name']} "
                f"{parsed['tokens']}tk \"{parsed['message'][:40]}\""
            )
        else:
            logger.debug(
                f"{self.cast_name}: CHAT {parsed['user_name']}: "
                f"{parsed['message'][:60]}"
            )

        row = {
            "account_id": self.account_id,
            "cast_name": self.cast_name,
            "message_time": parsed["message_time"],
            "msg_type": parsed["msg_type"],
            "user_name": parsed["user_name"],
            "message": parsed["message"],
            "tokens": parsed["tokens"],
            "is_vip": parsed["is_vip"],
            "session_id": self.session_id,
            "user_league": parsed["user_league"] or None,
            "user_level": parsed["user_level"] or None,
            "metadata": json.dumps({
                "source": "collector-ws-py",
                "isModel": parsed["is_model"] or None,
                "isKing": parsed["is_king"] or None,
                "isKnight": parsed["is_knight"] or None,
                "isFanClub": parsed["is_fan_club"] or None,
                "stripchatUserId": parsed["user_id_stripchat"] or None,
            }),
        }
        self._buffer.append(row)

    def _on_model_event(self, data: dict):
        """モデルイベントを処理"""
        event_type = str(data.get("event") or data.get("type") or "unknown")
        logger.info(f"{self.cast_name}: EVENT {event_type}")

        row = {
            "account_id": self.account_id,
            "cast_name": self.cast_name,
            "message_time": _now_iso(),
            "msg_type": "system",
            "user_name": "collector",
            "message": f"Model event: {event_type}",
            "tokens": 0,
            "is_vip": False,
            "session_id": self.session_id,
            "metadata": json.dumps({
                "source": "collector-ws-py",
                "event": event_type,
            }),
        }
        self._buffer.append(row)

    async def _flush_loop(self):
        """30秒毎にバッファをフラッシュ"""
        try:
            while self._running:
                await asyncio.sleep(30)
                await self._flush_buffer()
        except asyncio.CancelledError:
            pass

    async def _flush_buffer(self):
        """バッファ内のメッセージをSupabaseにバッチINSERT"""
        if not self._buffer:
            return

        rows = self._buffer[:]
        self._buffer.clear()

        try:
            sb = get_supabase()
            # 500件ずつ分割
            batch_size = 500
            for i in range(0, len(rows), batch_size):
                batch = rows[i : i + batch_size]
                sb.table("spy_messages").insert(batch).execute()
            logger.debug(f"{self.cast_name}: spy_messages {len(rows)}件 INSERT")
        except Exception as e:
            logger.error(f"{self.cast_name}: spy_messages INSERT失敗: {e}")
            # 失敗分はバッファに戻す（次回フラッシュで再試行）
            self._buffer = rows + self._buffer


async def get_centrifugo_jwt() -> tuple[str, str]:
    """
    Centrifugo WebSocket用のJWTトークンを取得。

    方式C: ページHTMLの __PRELOADED_STATE__ からcentrifugoTokenを抽出
    方式B: /api/front/v2/config からcentrifugoTokenを取得
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "ja,en-US;q=0.9",
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        # 方式C: ページHTML
        try:
            resp = await client.get("https://stripchat.com/Risa_06", headers=headers)
            if resp.status_code == 200:
                html = resp.text
                import re

                match = re.search(
                    r"window\.__PRELOADED_STATE__\s*=\s*({.+?});", html, re.DOTALL
                )
                if match:
                    state = json.loads(match.group(1))
                    jwt = (
                        _nested_get(state, "config", "centrifugoToken")
                        or _nested_get(state, "configV3", "centrifugoToken")
                        or _nested_get(state, "user", "centrifugoToken")
                        or ""
                    )
                    cf = ""
                    for cookie_header in resp.headers.get_list("set-cookie"):
                        import re as _re

                        m = _re.search(r"cf_clearance=([^;]+)", cookie_header)
                        if m:
                            cf = m.group(1)
                    if jwt:
                        logger.info(f"JWT取得: 方式C (ページHTML) jwt={jwt[:20]}...")
                        return jwt, cf
        except Exception as e:
            logger.debug(f"方式C失敗: {e}")

        # 方式B: REST config
        try:
            resp = await client.get(
                "https://stripchat.com/api/front/v2/config",
                headers={**headers, "Accept": "application/json"},
            )
            if resp.status_code == 200:
                config = resp.json()
                jwt = (
                    _deep_find(config, "centrifugoToken")
                    or ""
                )
                if jwt:
                    logger.info(f"JWT取得: 方式B (REST config) jwt={jwt[:20]}...")
                    return jwt, ""
        except Exception as e:
            logger.debug(f"方式B失敗: {e}")

    logger.warning("Centrifugo JWT取得失敗: 全方式失敗")
    return "", ""


def _nested_get(d: dict, *keys):
    """ネストされた辞書から値を取得"""
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
        if d is None:
            return None
    return d


def _deep_find(obj, key: str, depth: int = 0):
    """再帰的にキーを探索（最大深度5）"""
    if depth > 5 or not isinstance(obj, dict):
        return None
    if key in obj and isinstance(obj[key], str):
        return obj[key]
    for v in obj.values():
        if isinstance(v, dict):
            found = _deep_find(v, key, depth + 1)
            if found:
                return found
    return None
