"""
dm_guard.py — DM送信安全ゲート（Python版）

インシデント対策: テストDMが本物の顧客に送信された問題を防止する

1. DM_TEST_MODE: デフォルトON。テスト時はホワイトリスト以外への送信をブロック
2. campaign必須: campaign_idなしのDMは送信拒否
"""

import logging
import os

logger = logging.getLogger(__name__)

# ─── ホワイトリスト（テストモードで許可するユーザー名） ───
DM_TEST_WHITELIST = frozenset([
    "pojipojipoji",
    "kantou1234",
    "Nekomeem34",
])


def is_dm_test_mode() -> bool:
    """テストモード判定。未設定はテストモードON（安全側デフォルト）"""
    val = os.environ.get("DM_TEST_MODE", "true").lower()
    return val not in ("false", "off", "0")


class DmGuardError(Exception):
    """DM安全ゲートエラー"""

    def __init__(self, message: str, code: str, blocked_users: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.blocked_users = blocked_users or []


def validate_dm_targets(user_names: list[str]) -> tuple[list[str], list[str], bool]:
    """
    テストモード時にホワイトリスト外をブロック。

    Returns:
        (allowed, blocked, is_test_mode)
    """
    test_mode = is_dm_test_mode()

    if not test_mode:
        return user_names, [], False

    allowed = [u for u in user_names if u in DM_TEST_WHITELIST]
    blocked = [u for u in user_names if u not in DM_TEST_WHITELIST]

    return allowed, blocked, True


def validate_campaign_required(campaign: str | None) -> None:
    """campaign必須バリデーション"""
    if not campaign or not campaign.strip():
        raise DmGuardError(
            "campaign_idが指定されていません。全てのDM送信にはcampaign_idが必須です。",
            "CAMPAIGN_REQUIRED",
        )


def guard_dm_send(user_names: list[str], campaign: str | None) -> tuple[list[str], list[str], bool]:
    """
    統合バリデーション。dm_send_log INSERT前に必ず呼ぶ。

    Returns:
        (allowed, blocked, is_test_mode)

    Raises:
        DmGuardError: campaign未指定 or テストモードでホワイトリスト外
    """
    # 1. campaign必須チェック
    validate_campaign_required(campaign)

    # 2. テストモード＋ホワイトリストチェック
    allowed, blocked, test_mode = validate_dm_targets(user_names)

    if test_mode and blocked:
        sample = ", ".join(blocked[:5])
        suffix = f" 他{len(blocked) - 5}名" if len(blocked) > 5 else ""
        raise DmGuardError(
            f"[DM_TEST_MODE] ホワイトリスト外のユーザーへの送信をブロック: {sample}{suffix}（{len(blocked)}名）。"
            f"許可ユーザー: {', '.join(sorted(DM_TEST_WHITELIST))}",
            "TEST_MODE_BLOCKED",
            blocked,
        )

    return allowed, blocked, test_mode
