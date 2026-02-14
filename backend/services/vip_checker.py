"""VIP checker - Ported from audio_server.py _check_vip()"""
from datetime import datetime, timedelta


VIP_TOKEN_THRESHOLD = 1000
VIP_LEVEL_THRESHOLD = 70
DEDUP_MINUTES = 5

# In-memory dedup cache (per-process)
_recent_alerts: dict[str, datetime] = {}


async def check_vip(sb, account_id: str, user_name: str) -> dict | None:
    """Check if user is VIP. Returns alert dict or None.

    VIP criteria:
    - 1000+ total tokens (whale)
    - Level 70+ on Stripchat (high_level)

    Deduplication: same user within 5 minutes → skip
    """
    if not user_name:
        return None

    # Dedup check
    cache_key = f"{account_id}:{user_name}"
    now = datetime.utcnow()
    if cache_key in _recent_alerts:
        if (now - _recent_alerts[cache_key]).total_seconds() < DEDUP_MINUTES * 60:
            return None
    
    # Look up user across all accounts for this user
    result = (sb.table("paid_users")
              .select("user_name, total_coins, last_payment_date, user_level")
              .eq("account_id", account_id)
              .eq("user_name", user_name)
              .limit(1)
              .execute())

    if not result.data:
        return None

    user = result.data[0]
    total = user.get("total_coins", 0) or 0
    level = user.get("user_level", 0) or 0
    last_paid = user.get("last_payment_date")

    # Lifecycle classification
    lifecycle = _classify_lifecycle(last_paid)

    alert = None

    if total >= VIP_TOKEN_THRESHOLD:
        alert = {
            "level": "whale",
            "total_tokens": total,
            "last_paid": last_paid,
            "user_level": level,
            "lifecycle": lifecycle,
            "alert_message": f"🐋 太客入室: {user_name} (累計{total}tk, {lifecycle})",
        }
    elif level >= VIP_LEVEL_THRESHOLD:
        alert = {
            "level": "high_level",
            "total_tokens": total,
            "last_paid": last_paid,
            "user_level": level,
            "lifecycle": lifecycle,
            "alert_message": f"⭐ 高レベル入室: {user_name} (Lv.{level})",
        }

    if alert:
        _recent_alerts[cache_key] = now
        # Clean old entries
        cutoff = now - timedelta(minutes=DEDUP_MINUTES * 2)
        expired = [k for k, v in _recent_alerts.items() if v < cutoff]
        for k in expired:
            del _recent_alerts[k]

    return alert


def _classify_lifecycle(last_paid: str | None) -> str:
    """Classify user lifecycle stage based on last payment date"""
    if not last_paid:
        return "new"
    try:
        last = datetime.fromisoformat(last_paid.replace("Z", "+00:00"))
        days_since = (datetime.utcnow() - last.replace(tzinfo=None)).days
        if days_since <= 7:
            return "active"
        elif days_since <= 30:
            return "dormant"
        else:
            return "churned"
    except (ValueError, TypeError):
        return "unknown"


def classify_comment(message: str | None, msg_type: str, tokens: int) -> dict:
    """Classify comment for pickup filtering.

    Categories:
    - is_whale: from a known big spender (handled at message level)
    - is_gift: gift/tip message
    - is_question: contains question patterns
    """
    result = {
        "is_whale": False,  # Set by caller based on VIP check
        "is_gift": msg_type in ("gift", "tip") or tokens > 0,
        "is_question": False,
        "priority": 0,
    }

    if not message:
        return result

    # Question detection
    question_patterns = ["?", "？", "教えて", "何", "どう", "いつ", "どこ", "誰", "なぜ",
                         "how", "what", "when", "where", "who", "why", "can you", "do you"]
    msg_lower = message.lower()
    if any(p in msg_lower for p in question_patterns):
        result["is_question"] = True

    # Priority scoring
    if result["is_gift"]:
        result["priority"] = 3
    elif result["is_question"]:
        result["priority"] = 2
    elif tokens > 0:
        result["priority"] = 1

    return result
