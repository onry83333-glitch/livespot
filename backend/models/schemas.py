"""Pydantic models for Morning Hook SaaS API"""
from datetime import datetime
from typing import Optional
from pydantic import BaseModel


# ============================================================
# Auth
# ============================================================
class UserProfile(BaseModel):
    id: str
    display_name: Optional[str] = None
    plan: str = "free"
    max_casts: int = 1
    max_dm_per_month: int = 10
    dm_used_this_month: int = 0
    ai_used_this_month: int = 0


# ============================================================
# Accounts
# ============================================================
class AccountCreate(BaseModel):
    account_name: str
    stripchat_cookie: Optional[str] = None

class AccountResponse(BaseModel):
    id: str
    account_name: str
    is_active: bool
    created_at: datetime


# ============================================================
# DM
# ============================================================
class DMQueueCreate(BaseModel):
    account_id: str
    user_names: list[str]
    message: str
    image_url: Optional[str] = None
    campaign: str = ""
    template_name: str = ""


class DMBatchCreate(BaseModel):
    """Web UIからの一斉送信リクエスト"""
    targets: list[str]  # URLまたはユーザー名
    message: str
    image_url: Optional[str] = None
    send_order: str = "text-image"   # text-image, image-text, text-only
    send_mode: str = "sequential"    # sequential, pipeline
    concurrent_tabs: int = 1


class DMBatchResponse(BaseModel):
    queued: int
    batch_id: str
    send_order: str
    send_mode: str
    concurrent_tabs: int


class DMBatchStatus(BaseModel):
    batch_id: str
    total: int
    queued: int
    sending: int
    success: int
    error: int
    items: list[dict]


class DMStatusUpdate(BaseModel):
    status: str  # success, error, sending
    error: Optional[str] = None
    sent_at: Optional[datetime] = None

class DMTemplateCreate(BaseModel):
    account_id: str
    name: str
    message: str
    image_url: Optional[str] = None
    is_default: bool = False

class DMLogResponse(BaseModel):
    id: int
    user_name: str
    message: Optional[str]
    status: str
    campaign: str
    sent_at: Optional[datetime]
    queued_at: datetime


# ============================================================
# SPY
# ============================================================
class CastTagsUpdate(BaseModel):
    genre: Optional[str] = None
    benchmark: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class SpyMessageCreate(BaseModel):
    account_id: str
    cast_name: str
    message_time: datetime
    msg_type: str  # chat, gift, tip, enter, leave, system
    user_name: Optional[str] = None
    message: Optional[str] = None
    tokens: int = 0
    metadata: dict = {}
    session_id: Optional[str] = None
    session_title: Optional[str] = None
    user_color: Optional[str] = None
    user_league: Optional[str] = None
    user_level: Optional[int] = None

class SpyMessageResponse(BaseModel):
    id: int
    cast_name: str
    message_time: datetime
    msg_type: str
    user_name: Optional[str]
    message: Optional[str]
    tokens: int
    is_vip: bool
    metadata: dict

class VIPAlert(BaseModel):
    user_name: str
    level: str  # whale, high_level
    total_tokens: int
    last_paid: Optional[datetime]
    user_level: int
    lifecycle: str  # active, dormant, churned, new
    alert_message: str


# ============================================================
# Sessions
# ============================================================
class SessionCreate(BaseModel):
    account_id: str
    session_id: str
    title: Optional[str] = None
    started_at: datetime


class SessionUpdate(BaseModel):
    ended_at: Optional[datetime] = None
    title: Optional[str] = None


# ============================================================
# Viewer Stats
# ============================================================
class ViewerStatsCreate(BaseModel):
    account_id: str
    cast_name: str
    total: Optional[int] = None
    coin_users: Optional[int] = None
    others: Optional[int] = None
    ultimate_count: Optional[int] = None
    coin_holders: Optional[int] = None
    others_count: Optional[int] = None
    recorded_at: Optional[datetime] = None


class ViewerStatsBatchCreate(BaseModel):
    account_id: str
    cast_name: str
    stats: list[dict]  # [{ total, coin_users, others, ultimate_count, coin_holders, others_count, recorded_at }]


# ============================================================
# Account Settings
# ============================================================
class AccountSettingsUpdate(BaseModel):
    cast_usernames: Optional[list[str]] = None
    coin_rate: Optional[float] = None


# ============================================================
# Sync
# ============================================================
class SyncStatus(BaseModel):
    account_id: str
    last_sync: Optional[datetime]
    total_users: int
    total_transactions: int


# ============================================================
# Analytics
# ============================================================
class DailySales(BaseModel):
    date: str
    tokens: int
    tx_count: int

class TopUser(BaseModel):
    user_name: str
    total_tokens: int
    last_paid: Optional[datetime]
    first_paid: Optional[datetime]
    tx_count: int

class ARPUData(BaseModel):
    month: str
    arpu: float
    unique_payers: int
    total_tokens: int

class DMEffectiveness(BaseModel):
    campaign: str
    dm_sent_count: int
    reconverted_count: int
    conversion_rate: float
    reconverted_tokens: int


# ============================================================
# AI
# ============================================================
class AIAssistRequest(BaseModel):
    account_id: str
    cast_name: str
    recent_messages: list[dict]  # [{user_name, message, msg_type, tokens}]
    context: Optional[str] = None

class AIReportResponse(BaseModel):
    id: str
    report_type: str
    output_text: str
    model: str
    created_at: datetime


# ============================================================
# Scripts
# ============================================================
class ScriptCreate(BaseModel):
    account_id: str
    cast_name: Optional[str] = None
    title: str
    duration_minutes: int = 120
    steps: list[dict] = []
    vip_rules: list[dict] = []
    notes: str = ""
    is_default: bool = False

class ScriptResponse(BaseModel):
    id: str
    title: str
    duration_minutes: int
    steps: list[dict]
    vip_rules: list[dict]
    notes: str
    is_default: bool
    created_at: datetime
