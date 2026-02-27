"""
ADM (Auto DM) Engine — 新規ユーザー検出 → トリガー発火 → DM自動送信

paid_usersに新規追加されたユーザーを検出し、
dm_triggersのルールに基づいて自動DMをキュー登録する。
"""

import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

logger = logging.getLogger(__name__)

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")


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
# テンプレート変数展開
# ---------------------------------------------------------------------------
def render_template(template: str, variables: dict) -> str:
    """メッセージテンプレートの変数を展開する"""
    if not template:
        return ""
    result = template
    for key, value in variables.items():
        result = result.replace(f"{{{key}}}", str(value or ""))
    return result


# ---------------------------------------------------------------------------
# 新規ユーザー検出
# ---------------------------------------------------------------------------
def detect_new_users(sb, account_id: str, cast_name: str | None, lookback_hours: int = 24) -> list[dict]:
    """
    paid_usersからlookback_hours以内に作成されたユーザーを検出。

    Returns:
        [{"user_name": str, "cast_name": str, "total_coins": int, "segment": str, ...}]
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()

    query = (
        sb.table("paid_users")
        .select("user_name, cast_name, total_coins, segment, created_at")
        .eq("account_id", account_id)
        .gte("created_at", cutoff)
    )

    if cast_name:
        query = query.eq("cast_name", cast_name)

    result = query.order("created_at", desc=True).limit(500).execute()
    return result.data or []


# ---------------------------------------------------------------------------
# クールダウン＋日次上限チェック
# ---------------------------------------------------------------------------
def get_fired_users(sb, trigger_id: str, cooldown_hours: int) -> set[str]:
    """クールダウン期間内にすでにDM発火済みのユーザー名一覧を取得"""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=cooldown_hours)).isoformat()

    result = (
        sb.table("dm_trigger_logs")
        .select("user_name")
        .eq("trigger_id", trigger_id)
        .in_("action_taken", ["dm_queued", "scenario_enrolled"])
        .gte("fired_at", cutoff)
        .limit(10000)
        .execute()
    )
    return {r["user_name"] for r in (result.data or [])}


def get_daily_fire_count(sb, trigger_id: str) -> int:
    """今日のトリガー発火回数を取得"""
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    result = (
        sb.table("dm_trigger_logs")
        .select("id", count="exact")
        .eq("trigger_id", trigger_id)
        .in_("action_taken", ["dm_queued", "scenario_enrolled"])
        .gte("fired_at", today_start)
        .execute()
    )
    return result.count or 0


def get_already_dm_sent_users(sb, account_id: str, cast_name: str | None, user_names: list[str]) -> set[str]:
    """dm_send_logに既にDM送信済み（24h以内、error以外）のユーザーを取得"""
    if not user_names:
        return set()

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    query = (
        sb.table("dm_send_log")
        .select("user_name")
        .eq("account_id", account_id)
        .in_("user_name", user_names)
        .neq("status", "error")
        .gte("queued_at", cutoff)
    )

    if cast_name:
        query = query.eq("cast_name", cast_name)

    result = query.limit(10000).execute()
    return {r["user_name"] for r in (result.data or [])}


# ---------------------------------------------------------------------------
# トリガー発火（1トリガー分）
# ---------------------------------------------------------------------------
def fire_trigger(
    sb,
    trigger: dict,
    new_users: list[dict],
    account_id: str,
) -> dict:
    """
    1つのトリガーに対して、新規ユーザーへのDMを発火する。

    Returns:
        {"queued": int, "skipped_cooldown": int, "skipped_duplicate": int, "skipped_daily_limit": int, "errors": int}
    """
    trigger_id = trigger["id"]
    trigger_name = trigger["trigger_name"]
    cast_name = trigger.get("cast_name")
    message_template = trigger.get("message_template", "")
    cooldown_hours = trigger.get("cooldown_hours", 168)
    daily_limit = trigger.get("daily_limit", 50)

    stats = {
        "queued": 0,
        "skipped_cooldown": 0,
        "skipped_duplicate": 0,
        "skipped_daily_limit": 0,
        "errors": 0,
    }

    if not message_template:
        logger.warning(f"トリガー '{trigger_name}' にメッセージテンプレートが未設定")
        return stats

    # キャスト名でフィルタ（トリガーにcast_name指定があれば）
    eligible_users = new_users
    if cast_name:
        eligible_users = [u for u in new_users if u.get("cast_name") == cast_name]

    if not eligible_users:
        return stats

    # クールダウン済みユーザーを除外
    fired_users = get_fired_users(sb, trigger_id, cooldown_hours)

    # 24h以内DM送信済みユーザーを除外
    user_names = [u["user_name"] for u in eligible_users]
    dm_sent_users = get_already_dm_sent_users(sb, account_id, cast_name, user_names)

    # 日次上限チェック
    daily_count = get_daily_fire_count(sb, trigger_id)

    now = datetime.now(timezone.utc).isoformat()
    campaign = f"adm_{trigger['trigger_type']}_{datetime.now(timezone.utc).strftime('%Y%m%d')}"

    for user in eligible_users:
        user_name = user["user_name"]
        user_cast = user.get("cast_name") or cast_name or ""

        # 日次上限チェック
        if daily_count + stats["queued"] >= daily_limit:
            stats["skipped_daily_limit"] += 1
            _log_trigger_skip(sb, trigger_id, account_id, user_cast, user_name, "skipped_daily_limit")
            continue

        # クールダウンチェック
        if user_name in fired_users:
            stats["skipped_cooldown"] += 1
            _log_trigger_skip(sb, trigger_id, account_id, user_cast, user_name, "skipped_cooldown")
            continue

        # 24h DM重複チェック
        if user_name in dm_sent_users:
            stats["skipped_duplicate"] += 1
            _log_trigger_skip(sb, trigger_id, account_id, user_cast, user_name, "skipped_duplicate")
            continue

        # メッセージ生成
        variables = {
            "username": user_name,
            "cast_name": user_cast,
            "total_coins": str(user.get("total_coins", 0)),
            "segment": user.get("segment", ""),
        }
        message = render_template(message_template, variables)

        try:
            # dm_send_log にキュー登録
            dm_result = (
                sb.table("dm_send_log")
                .insert({
                    "account_id": account_id,
                    "cast_name": user_cast,
                    "user_name": user_name,
                    "message": message,
                    "status": "queued",
                    "campaign": campaign,
                    "template_name": trigger_name,
                })
                .execute()
            )

            dm_log_id = dm_result.data[0]["id"] if dm_result.data else None

            # dm_trigger_logs に発火ログ記録
            sb.table("dm_trigger_logs").insert({
                "trigger_id": trigger_id,
                "account_id": account_id,
                "cast_name": user_cast,
                "user_name": user_name,
                "action_taken": "dm_queued",
                "dm_send_log_id": dm_log_id,
                "metadata": {
                    "campaign": campaign,
                    "total_coins": user.get("total_coins", 0),
                    "segment": user.get("segment"),
                    "created_at": user.get("created_at"),
                },
            }).execute()

            stats["queued"] += 1

        except Exception as e:
            logger.error(f"トリガー発火エラー ({trigger_name} → {user_name}): {e}")
            try:
                sb.table("dm_trigger_logs").insert({
                    "trigger_id": trigger_id,
                    "account_id": account_id,
                    "cast_name": user_cast,
                    "user_name": user_name,
                    "action_taken": "error",
                    "error_message": str(e)[:500],
                }).execute()
            except Exception:
                pass
            stats["errors"] += 1

    return stats


def _log_trigger_skip(sb, trigger_id: str, account_id: str, cast_name: str, user_name: str, reason: str):
    """スキップログを記録（エラーは無視）"""
    try:
        sb.table("dm_trigger_logs").insert({
            "trigger_id": trigger_id,
            "account_id": account_id,
            "cast_name": cast_name or "",
            "user_name": user_name,
            "action_taken": reason,
        }).execute()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# ADMサイクル実行（メインオーケストレーター）
# ---------------------------------------------------------------------------
async def run_adm_cycle(sb, account_id: str, lookback_hours: int = 24) -> dict:
    """
    ADM（自動DM）サイクルを1回実行する。

    1. first_visit タイプの有効トリガーを取得
    2. 新規ユーザーを検出
    3. 各トリガーに対してDMを発火
    4. Telegram通知

    Returns:
        {"triggers_evaluated": int, "total_queued": int, "total_skipped": int, "details": [...]}
    """
    # 1. 有効な first_visit トリガーを取得
    triggers_result = (
        sb.table("dm_triggers")
        .select("*")
        .eq("account_id", account_id)
        .eq("trigger_type", "first_visit")
        .eq("enabled", True)
        .order("priority")
        .execute()
    )
    triggers = triggers_result.data or []

    if not triggers:
        logger.info(f"[ADM] 有効なfirst_visitトリガーなし (account_id={account_id[:8]})")
        return {
            "triggers_evaluated": 0,
            "total_queued": 0,
            "total_skipped": 0,
            "details": [],
            "message": "有効なfirst_visitトリガーが見つかりません",
        }

    # 2. 新規ユーザーを検出（全キャスト横断）
    new_users = detect_new_users(sb, account_id, cast_name=None, lookback_hours=lookback_hours)

    if not new_users:
        logger.info(f"[ADM] 新規ユーザーなし (lookback={lookback_hours}h)")
        return {
            "triggers_evaluated": len(triggers),
            "total_queued": 0,
            "total_skipped": 0,
            "new_users_detected": 0,
            "details": [],
            "message": f"過去{lookback_hours}時間に新規ユーザーは検出されませんでした",
        }

    logger.info(f"[ADM] 新規ユーザー {len(new_users)}名検出、トリガー {len(triggers)}件評価開始")

    # 3. 各トリガーを評価・発火
    total_queued = 0
    total_skipped = 0
    details = []

    for trigger in triggers:
        stats = fire_trigger(sb, trigger, new_users, account_id)
        total_queued += stats["queued"]
        total_skipped += stats["skipped_cooldown"] + stats["skipped_duplicate"] + stats["skipped_daily_limit"]

        details.append({
            "trigger_name": trigger["trigger_name"],
            "trigger_id": trigger["id"],
            "cast_name": trigger.get("cast_name"),
            **stats,
        })

    # 4. Telegram通知
    if total_queued > 0:
        trigger_names = ", ".join(d["trigger_name"] for d in details if d["queued"] > 0)
        await send_telegram(
            f"🤖 <b>ADM自動発火</b>\n"
            f"新規ユーザー: {len(new_users)}名検出\n"
            f"DM送信キュー: {total_queued}件\n"
            f"スキップ: {total_skipped}件\n"
            f"トリガー: {trigger_names}"
        )

    result = {
        "triggers_evaluated": len(triggers),
        "new_users_detected": len(new_users),
        "total_queued": total_queued,
        "total_skipped": total_skipped,
        "details": details,
    }

    logger.info(f"[ADM] サイクル完了: queued={total_queued}, skipped={total_skipped}")
    return result
