"""Configuration and Supabase client setup"""
import os
import re
from functools import lru_cache
from pydantic_settings import BaseSettings

# ============================================================
# supabase-py 2.10.0 の API Key バリデーションをパッチ
# 新しい Supabase キー形式 (sb_secret_...) を受け付けるようにする
# ============================================================
import supabase._sync.client as _sb_sync

_original_init = _sb_sync.SyncClient.__init__

def _patched_init(self, supabase_url, supabase_key, options=None):
    """__init__ をラップして Invalid API key チェックをスキップ"""
    # URL/Key 空チェックだけ残す
    if not supabase_url:
        raise _sb_sync.SupabaseException("supabase_url is required")
    if not supabase_key:
        raise _sb_sync.SupabaseException("supabase_key is required")
    if not re.match(r"^(https?)://.+", supabase_url):
        raise _sb_sync.SupabaseException("Invalid URL")

    # key チェックを一切行わずに元の初期化を実行するため、
    # 一時的に正規表現にマッチするダミーを通す
    _real_re_match = re.match
    def _permissive_match(pattern, string, *args, **kwargs):
        # API key の正規表現パターン（.を含む JWT 形式）だけスキップ
        if r"[A-Za-z0-9-_=]+\." in str(pattern):
            return True  # 常にマッチ
        return _real_re_match(pattern, string, *args, **kwargs)

    re.match = _permissive_match
    try:
        _original_init(self, supabase_url, supabase_key, options)
    finally:
        re.match = _real_re_match

_sb_sync.SyncClient.__init__ = _patched_init

from supabase import create_client, Client


class Settings(BaseSettings):
    # Supabase
    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_jwt_secret: str = ""

    # Anthropic
    anthropic_api_key: str = ""

    # App
    api_base_url: str = "http://localhost:8000"
    cors_origins: str = "http://localhost:3000"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


def get_supabase_admin() -> Client:
    """Service-role client for backend operations (bypasses RLS)"""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_key)


def get_supabase_for_user(jwt_token: str) -> Client:
    """User-scoped client that respects RLS"""
    settings = get_settings()
    client = create_client(settings.supabase_url, settings.supabase_service_key)
    client.postgrest.auth(jwt_token)
    return client
