#!/usr/bin/env python3
"""
SLS データ整合性チェッカー v1.0
Supabase全テーブル間のデータ連動をクロスチェックし、不整合・穴・孤立データを検出する。

Usage:
    cd C:\\dev\\livespot
    python scripts/data_integrity_check.py
"""

import os
import sys
import time
import json
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

# ═══════════════════════════════════════════════
#  環境変数読み込み
# ═══════════════════════════════════════════════
def load_env():
    """backend/.env と frontend/.env.local から環境変数を読み込む"""
    env_files = [
        Path(__file__).resolve().parent.parent / "backend" / ".env",
        Path(__file__).resolve().parent.parent / "frontend" / ".env.local",
    ]
    for p in env_files:
        if p.exists():
            with open(p, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, _, v = line.partition("=")
                        os.environ.setdefault(k.strip(), v.strip())

load_env()

# ── HTTP クライアント ──
try:
    import httpx
except ImportError:
    print("httpx が必要です: pip install httpx")
    sys.exit(1)

# ═══════════════════════════════════════════════
#  定数
# ═══════════════════════════════════════════════
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or "https://ujgbhkllfeacbgpdbjto.supabase.co"
)
API_KEY = (
    os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    or ""
)
REST_URL = f"{SUPABASE_URL}/rest/v1"
VALID_SINCE = "2025-02-15T00:00:00+00:00"
VALID_DATE = "2025-02-15"

# ═══════════════════════════════════════════════
#  ANSI カラー
# ═══════════════════════════════════════════════
if sys.platform == "win32":
    os.system("")  # enable ANSI on Windows
    # Windows: stdout を UTF-8 に強制
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

class C:
    RST = "\033[0m"
    B   = "\033[1m"
    DIM = "\033[2m"
    R   = "\033[91m"
    G   = "\033[92m"
    Y   = "\033[93m"
    BL  = "\033[94m"
    P   = "\033[95m"
    CY  = "\033[96m"

# ═══════════════════════════════════════════════
#  Supabase REST API クライアント
# ═══════════════════════════════════════════════
class SupaRest:
    """PostgREST API を直接呼び出す軽量クライアント"""

    def __init__(self, base_url: str, api_key: str):
        self.base = base_url
        self.headers = {
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "count=exact",
        }
        self.client = httpx.Client(timeout=30.0)

    def count(self, table: str, params: str = "") -> int:
        """行数のみカウント (HEAD + count=exact)"""
        url = f"{self.base}/{table}?select=id&limit=0{('&' + params) if params else ''}"
        resp = self.client.get(url, headers=self.headers)
        if resp.status_code >= 400:
            raise Exception(f"HTTP {resp.status_code}: {resp.text[:100]}")
        cr = resp.headers.get("content-range", "")
        # content-range: 0-0/1234 or */1234
        if "/" in cr:
            total = cr.split("/")[-1]
            return int(total) if total != "*" else 0
        return 0

    def fetch(self, table: str, columns: str, params: str = "",
              max_rows: int = 50000) -> list:
        """ページネーション付き全行取得"""
        all_data = []
        page_size = 1000
        offset = 0
        while offset < max_rows:
            url = (f"{self.base}/{table}"
                   f"?select={columns}&limit={page_size}&offset={offset}"
                   f"{('&' + params) if params else ''}")
            resp = self.client.get(url, headers=self.headers)
            if resp.status_code >= 400:
                raise Exception(f"HTTP {resp.status_code}: {resp.text[:100]}")
            batch = resp.json()
            all_data.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
        return all_data

    def fetch_one(self, table: str, columns: str, params: str = ""):
        """1行だけ取得"""
        url = f"{self.base}/{table}?select={columns}&limit=1{('&' + params) if params else ''}"
        resp = self.client.get(url, headers=self.headers)
        if resp.status_code >= 400:
            return None
        data = resp.json()
        return data[0] if data else None

# ═══════════════════════════════════════════════
#  ユーティリティ
# ═══════════════════════════════════════════════
def fmt(n):
    return f"{n:,}" if isinstance(n, int) else str(n)

def progress(msg):
    sys.stdout.write(f"\r  {C.DIM}⏳ {msg}{C.RST}\033[K")
    sys.stdout.flush()

def progress_done(msg):
    sys.stdout.write(f"\r  {C.G}✓{C.RST} {msg}\033[K\n")
    sys.stdout.flush()

class CheckResult:
    def __init__(self):
        self.counts = {"PASS": 0, "WARN": 0, "FAIL": 0, "INFO": 0, "SKIP": 0}
        self.actions = []

    ICONS = {
        "PASS": f"{C.G}✅ PASS{C.RST}",
        "WARN": f"{C.Y}⚠️  WARN{C.RST}",
        "FAIL": f"{C.R}❌ FAIL{C.RST}",
        "INFO": f"{C.BL}ℹ️  INFO{C.RST}",
        "SKIP": f"{C.DIM}⏭️  SKIP{C.RST}",
    }

    def record(self, cid, desc, status, detail=""):
        self.counts[status] = self.counts.get(status, 0) + 1
        icon = self.ICONS.get(status, status)
        line = f"  {C.B}{cid}{C.RST}: {desc:<40} {icon}"
        if detail:
            line += f" {C.DIM}({detail}){C.RST}"
        print(line)

    def action(self, msg):
        self.actions.append(msg)

# ═══════════════════════════════════════════════
#  メイン
# ═══════════════════════════════════════════════
def main():
    if not API_KEY:
        print(f"{C.R}Supabase API Key が未設定です{C.RST}")
        print("  backend/.env の SUPABASE_SERVICE_KEY を確認してください")
        return 1

    db = SupaRest(REST_URL, API_KEY)
    cr = CheckResult()
    now_jst = datetime.now(timezone(timedelta(hours=9)))
    t0 = time.time()

    # ── ヘッダー ──
    print(f"\n{C.CY}{'═' * 55}{C.RST}")
    print(f"  {C.B}SLS データ整合性チェッカー v1.0{C.RST}")
    print(f"  実行日時: {now_jst.strftime('%Y-%m-%d %H:%M:%S')} JST")
    print(f"  対象: Supabase ujgbhkllfeacbgpdbjto (Tokyo)")
    print(f"  有効データ: {VALID_DATE} 以降")
    print(f"{C.CY}{'═' * 55}{C.RST}\n")

    # ══════════════════════════════════════
    #  接続テスト
    # ══════════════════════════════════════
    try:
        db.count("registered_casts")
        print(f"  {C.G}✓{C.RST} Supabase接続OK\n")
    except Exception as e:
        print(f"  {C.R}✗ Supabase接続失敗: {e}{C.RST}")
        print(f"    API Key: {API_KEY[:20]}...")
        return 1

    # ══════════════════════════════════════
    #  テーブルサマリー
    # ══════════════════════════════════════
    print(f"{C.B}📊 テーブルサマリー{C.RST}")
    table_list = [
        "coin_transactions", "paid_users", "dm_send_log",
        "spy_messages", "sessions", "registered_casts",
    ]
    table_counts = {}
    for tbl in table_list:
        try:
            cnt = db.count(tbl)
            table_counts[tbl] = cnt
            print(f"  {tbl:<24} {C.G}{fmt(cnt):>12}{C.RST} 行")
        except Exception:
            table_counts[tbl] = -1
            print(f"  {tbl:<24} {C.R}{'ERROR':>12}{C.RST}")
    print()

    # ══════════════════════════════════════
    #  共有データロード
    # ══════════════════════════════════════
    print(f"{C.B}📥 データロード{C.RST}")

    # A. coin_transactions (有効期間のみ)
    vs = quote(VALID_SINCE)
    progress("coin_transactions...")
    coin_data = db.fetch(
        "coin_transactions", "user_name,cast_name,tokens,date",
        params=f"date=gte.{vs}&order=date.desc",
        max_rows=200000,
    )
    progress_done(f"coin_transactions: {len(coin_data):,}行")

    # B. dm_send_log
    progress("dm_send_log...")
    dm_data = db.fetch("dm_send_log", "user_name,cast_name,campaign,status")
    progress_done(f"dm_send_log: {len(dm_data):,}行")

    # C. registered_casts
    progress("registered_casts...")
    reg_data = db.fetch("registered_casts", "cast_name", params="is_active=eq.true")
    reg_names = {r["cast_name"] for r in reg_data if r.get("cast_name")}
    progress_done(f"registered_casts: {len(reg_data)}行 ({', '.join(sorted(reg_names)) or 'なし'})")

    # D. spy_casts
    try:
        progress("spy_casts...")
        spy_c_data = db.fetch("spy_casts", "cast_name", params="is_active=eq.true")
        spy_c_names = {r["cast_name"] for r in spy_c_data if r.get("cast_name")}
        progress_done(f"spy_casts: {len(spy_c_data)}行")
    except Exception:
        spy_c_names = set()
        progress_done("spy_casts: スキップ")

    all_known = reg_names | spy_c_names

    # E. sessions
    progress("sessions...")
    sess_data = db.fetch(
        "sessions", "cast_name,title,started_at,ended_at",
        params=f"started_at=gte.{vs}",
    )
    progress_done(f"sessions: {len(sess_data):,}行")

    print()

    # ══════════════════════════════════════
    #  カテゴリ1: キャスト別データ分離
    # ══════════════════════════════════════
    print(f"{C.CY}{'─' * 55}{C.RST}")
    print(f"{C.B}🔍 カテゴリ1: キャスト別データ分離{C.RST}")
    print(f"{C.CY}{'─' * 55}{C.RST}")

    # CHECK-01: coin_transactions cast_name NULL
    null_cast_coin = sum(1 for r in coin_data if not r.get("cast_name"))
    if null_cast_coin == 0:
        cr.record("CHECK-01", "coin_tx cast_name NULL", "PASS", "0件")
    else:
        cr.record("CHECK-01", "coin_tx cast_name NULL", "FAIL", f"{fmt(null_cast_coin)}件")
        cr.action(f"[FAIL] CHECK-01: coin_transactionsに{fmt(null_cast_coin)}件のcast_name NULL → reassign RPC実行を推奨")

    # CHECK-02: paid_users cast_name (カラム未実装)
    cr.record("CHECK-02", "paid_users cast_name", "SKIP",
              "カラム未実装 → coin_transactions経由で特定")
    cr.action("[INFO] CHECK-02: paid_usersにcast_nameカラムなし → coin_transactions.cast_nameで代用")

    # CHECK-03: dm_send_log cast_name NULL
    null_cast_dm = sum(1 for r in dm_data if not r.get("cast_name"))
    if null_cast_dm == 0:
        cr.record("CHECK-03", "dm_send_log cast_name NULL", "PASS", "0件")
    elif null_cast_dm < 50:
        cr.record("CHECK-03", "dm_send_log cast_name NULL", "WARN", f"{fmt(null_cast_dm)}件")
        cr.action(f"[WARN] CHECK-03: dm_send_logに{fmt(null_cast_dm)}件のcast_name NULL")
    else:
        cr.record("CHECK-03", "dm_send_log cast_name NULL", "FAIL", f"{fmt(null_cast_dm)}件")
        cr.action(f"[FAIL] CHECK-03: dm_send_logに{fmt(null_cast_dm)}件のcast_name NULL → キャスト付与を確認")

    # CHECK-04: キャスト間ユーザー重複
    user_casts = defaultdict(set)
    for r in coin_data:
        if r.get("user_name") and r.get("cast_name"):
            user_casts[r["user_name"]].add(r["cast_name"])
    multi_users = {u: cs for u, cs in user_casts.items() if len(cs) > 1}
    if not multi_users:
        cr.record("CHECK-04", "キャスト間ユーザー重複", "PASS", "0名")
    else:
        cr.record("CHECK-04", "キャスト間ユーザー重複", "INFO",
                  f"{len(multi_users)}名が複数キャストに存在")
        for u, cs in list(sorted(multi_users.items(), key=lambda x: -len(x[1])))[:5]:
            print(f"    {C.DIM}└ {u}: {', '.join(sorted(cs))}{C.RST}")

    # CHECK-05: 未登録cast_name使用
    coin_cast_names = {r["cast_name"] for r in coin_data if r.get("cast_name")}
    unknown_casts = coin_cast_names - all_known - {"unknown", ""}
    if not unknown_casts:
        cr.record("CHECK-05", "未登録cast_name使用", "PASS",
                  f"全{len(coin_cast_names)}キャスト登録済")
    else:
        cr.record("CHECK-05", "未登録cast_name使用", "WARN",
                  f"{len(unknown_casts)}件: {', '.join(sorted(unknown_casts)[:5])}")
        cr.action(f"[WARN] CHECK-05: 未登録cast_name: {', '.join(sorted(unknown_casts))}")

    print()

    # ══════════════════════════════════════
    #  カテゴリ2: DMキャンペーン連動
    # ══════════════════════════════════════
    print(f"{C.CY}{'─' * 55}{C.RST}")
    print(f"{C.B}📨 カテゴリ2: DMキャンペーン連動{C.RST}")
    print(f"{C.CY}{'─' * 55}{C.RST}")

    # CHECK-06: キャンペーンタグ一覧
    campaign_map = defaultdict(lambda: defaultdict(int))
    null_camp_casts = set()
    for r in dm_data:
        camp = r.get("campaign") or "(空)"
        cast = r.get("cast_name") or "NULL"
        campaign_map[camp][cast] += 1
        if cast == "NULL":
            null_camp_casts.add(camp)

    if not campaign_map:
        cr.record("CHECK-06", "キャンペーンタグ整合性", "INFO", "DMデータなし")
    elif not null_camp_casts:
        cr.record("CHECK-06", "キャンペーンタグ整合性", "PASS",
                  f"{len(campaign_map)}キャンペーン")
    else:
        cr.record("CHECK-06", "キャンペーンタグ整合性", "WARN",
                  f"{len(null_camp_casts)}キャンペーンでcast_name=NULL")

    if campaign_map:
        for camp, casts in sorted(campaign_map.items(), key=lambda x: -sum(x[1].values())):
            parts = [f"{c}({n})" for c, n in sorted(casts.items())]
            print(f"    {C.DIM}└ {camp}: {', '.join(parts)}{C.RST}")

    # CHECK-07: DM先で課金記録なし
    dm_users = {r["user_name"] for r in dm_data if r.get("user_name")}
    coin_users = {r["user_name"] for r in coin_data if r.get("user_name")}
    dm_only = dm_users - coin_users
    if not dm_users:
        cr.record("CHECK-07", "DM先→課金記録なし", "INFO", "DMデータなし")
    else:
        pct = len(dm_only) / len(dm_users) * 100 if dm_users else 0
        cr.record("CHECK-07", "DM先→課金記録なし", "INFO",
                  f"{len(dm_only)}/{len(dm_users)}名 ({pct:.0f}%)")

    # CHECK-08: DM/コインのキャスト不一致
    dm_user_casts = defaultdict(set)
    for r in dm_data:
        if r.get("user_name") and r.get("cast_name"):
            dm_user_casts[r["user_name"]].add(r["cast_name"])

    coin_user_casts = defaultdict(set)
    for r in coin_data:
        if r.get("user_name") and r.get("cast_name"):
            coin_user_casts[r["user_name"]].add(r["cast_name"])

    mismatch = 0
    mismatch_ex = []
    for user, d_casts in dm_user_casts.items():
        if user in coin_user_casts:
            c_casts = coin_user_casts[user]
            diff = d_casts - c_casts
            if diff:
                mismatch += 1
                if len(mismatch_ex) < 3:
                    mismatch_ex.append(
                        f"{user}: DM={','.join(sorted(d_casts))} vs Coin={','.join(sorted(c_casts))}"
                    )

    if mismatch == 0:
        cr.record("CHECK-08", "DM/コインキャスト不一致", "PASS", "0名")
    elif mismatch < 10:
        cr.record("CHECK-08", "DM/コインキャスト不一致", "INFO", f"{mismatch}名")
    else:
        cr.record("CHECK-08", "DM/コインキャスト不一致", "WARN", f"{mismatch}名")
        cr.action(f"[WARN] CHECK-08: {mismatch}名のDM/コインキャスト不一致 → データ混在の可能性")
    for ex in mismatch_ex:
        print(f"    {C.DIM}└ {ex}{C.RST}")

    print()

    # ══════════════════════════════════════
    #  カテゴリ3: コイン取引データ品質
    # ══════════════════════════════════════
    print(f"{C.CY}{'─' * 55}{C.RST}")
    print(f"{C.B}💰 カテゴリ3: コイン取引データ品質{C.RST}")
    print(f"{C.CY}{'─' * 55}{C.RST}")

    # CHECK-09: マイナストークン
    neg_rows = [r for r in coin_data if (r.get("tokens") or 0) < 0]
    if not neg_rows:
        cr.record("CHECK-09", "マイナストークン", "PASS", "0件")
    else:
        cr.record("CHECK-09", "マイナストークン", "FAIL", f"{fmt(len(neg_rows))}件")
        cr.action(f"[FAIL] CHECK-09: {fmt(len(neg_rows))}件のマイナストークン → Chrome拡張差分計算バグ確認")
        for r in neg_rows[:3]:
            print(f"    {C.DIM}└ {r.get('user_name','?')}: {r.get('tokens',0)} tk "
                  f"({(r.get('date','')[:10]) if r.get('date') else '?'}){C.RST}")

    # CHECK-10: ゼロトークン
    zero_rows = [r for r in coin_data if r.get("tokens") == 0]
    if not zero_rows:
        cr.record("CHECK-10", "ゼロトークン", "PASS", "0件")
    elif len(zero_rows) < 100:
        cr.record("CHECK-10", "ゼロトークン", "INFO", f"{fmt(len(zero_rows))}件")
    else:
        cr.record("CHECK-10", "ゼロトークン", "WARN", f"{fmt(len(zero_rows))}件")
        cr.action(f"[WARN] CHECK-10: {fmt(len(zero_rows))}件のゼロトークン → 無意味データの可能性")

    # CHECK-11: 無効日付 (VALID_SINCE以前)
    try:
        old_count = db.count("coin_transactions", params=f"date=lt.{vs}")
        if old_count <= 0:
            cr.record("CHECK-11", f"無効日付データ (<{VALID_DATE})", "PASS", "0件")
        else:
            oldest_row = db.fetch_one(
                "coin_transactions", "date",
                params=f"date=lt.{vs}&order=date.asc",
            )
            oldest = oldest_row["date"][:10] if oldest_row else "不明"
            cr.record("CHECK-11", f"無効日付データ (<{VALID_DATE})", "WARN",
                      f"{fmt(old_count)}件, 最古: {oldest}")
            cr.action(f"[WARN] CHECK-11: {fmt(old_count)}件の無効期間データ (最古: {oldest})")
    except Exception as e:
        cr.record("CHECK-11", f"無効日付データ (<{VALID_DATE})", "SKIP", str(e)[:50])

    # CHECK-12: 完全重複行
    seen = defaultdict(int)
    for r in coin_data:
        key = (r.get("user_name", ""), r.get("cast_name", ""),
               r.get("tokens", 0), r.get("date", ""))
        seen[key] += 1
    dup_count = sum(v - 1 for v in seen.values() if v > 1)
    dup_groups = sum(1 for v in seen.values() if v > 1)
    if dup_count == 0:
        cr.record("CHECK-12", "完全重複行", "PASS", "0件")
    elif dup_count < 50:
        cr.record("CHECK-12", "完全重複行", "WARN",
                  f"{fmt(dup_count)}件 ({dup_groups}グループ)")
        cr.action(f"[WARN] CHECK-12: {fmt(dup_count)}件の完全重複 → 同期処理の冪等性を確認")
    else:
        cr.record("CHECK-12", "完全重複行", "FAIL",
                  f"{fmt(dup_count)}件 ({dup_groups}グループ)")
        cr.action(f"[FAIL] CHECK-12: {fmt(dup_count)}件の完全重複 → UPSERT制約の追加を検討")
    if dup_count > 0:
        top_dups = sorted(((k, v) for k, v in seen.items() if v > 1),
                          key=lambda x: -x[1])[:3]
        for (un, cn, tk, dt), cnt in top_dups:
            print(f"    {C.DIM}└ {un}/{cn}: {tk}tk @ {dt[:10] if dt else '?'} x{cnt}{C.RST}")

    print()

    # ══════════════════════════════════════
    #  カテゴリ4: セッション・SPYデータ連動
    # ══════════════════════════════════════
    print(f"{C.CY}{'─' * 55}{C.RST}")
    print(f"{C.B}📺 カテゴリ4: セッション・SPYデータ連動{C.RST}")
    print(f"{C.CY}{'─' * 55}{C.RST}")

    # CHECK-13: sessions 未登録cast_name
    sess_cast_names = set()
    for r in sess_data:
        cn = r.get("cast_name") or r.get("title")
        if cn:
            sess_cast_names.add(cn)
    unknown_sess = sess_cast_names - all_known - {"unknown", ""}
    if not sess_cast_names:
        cr.record("CHECK-13", "sessions 未登録cast_name", "SKIP", "セッションデータなし")
    elif not unknown_sess:
        cr.record("CHECK-13", "sessions 未登録cast_name", "PASS",
                  f"全{len(sess_cast_names)}キャスト登録済")
    else:
        cr.record("CHECK-13", "sessions 未登録cast_name", "WARN",
                  f"{len(unknown_sess)}件: {', '.join(sorted(unknown_sess)[:5])}")

    # CHECK-14: spy_messages 未登録cast_name
    try:
        total_spy = db.count("spy_messages", params=f"message_time=gte.{vs}")
        known_spy = 0
        for cn in all_known:
            cnt = db.count(
                "spy_messages",
                params=f"cast_name=eq.{quote(cn)}&message_time=gte.{vs}",
            )
            known_spy += cnt

        null_spy = db.count(
            "spy_messages",
            params=f"cast_name=is.null&message_time=gte.{vs}",
        )
        unknown_spy = max(0, total_spy - known_spy - null_spy)
        if unknown_spy == 0:
            cr.record("CHECK-14", "spy_messages 未登録cast_name", "PASS",
                      f"全{fmt(total_spy)}件が登録済キャスト")
        else:
            cr.record("CHECK-14", "spy_messages 未登録cast_name", "INFO",
                      f"{fmt(unknown_spy)}件が未登録キャスト (他社SPY含む)")
    except Exception as e:
        cr.record("CHECK-14", "spy_messages 未登録cast_name", "SKIP", str(e)[:50])

    # CHECK-15: SPY/セッション時間的整合性
    if not sess_data:
        cr.record("CHECK-15", "SPY/セッション時間整合", "SKIP", "セッションデータなし")
    else:
        try:
            cast_earliest = {}
            for s in sess_data:
                cn = s.get("cast_name") or s.get("title")
                if cn and s.get("started_at"):
                    if cn not in cast_earliest or s["started_at"] < cast_earliest[cn]:
                        cast_earliest[cn] = s["started_at"]

            orphan_total = 0
            checked = 0
            for cn, earliest in list(cast_earliest.items())[:10]:
                cnt = db.count(
                    "spy_messages",
                    params=(f"cast_name=eq.{quote(cn)}"
                            f"&message_time=lt.{quote(earliest)}"
                            f"&message_time=gte.{vs}"),
                )
                orphan_total += cnt
                checked += 1

            if orphan_total == 0:
                cr.record("CHECK-15", "SPY/セッション時間整合", "PASS",
                          f"{checked}キャストチェック済")
            else:
                cr.record("CHECK-15", "SPY/セッション時間整合", "INFO",
                          f"{fmt(orphan_total)}件がセッション開始前")
        except Exception as e:
            cr.record("CHECK-15", "SPY/セッション時間整合", "SKIP", str(e)[:50])

    # CHECK-16: セグメント整合性 (物理テーブルなし)
    cr.record("CHECK-16", "セグメント整合性", "SKIP",
              "segments は物理テーブルなし (RPC動的生成)")
    cr.action("[INFO] CHECK-16: segmentsテーブルは存在しない → get_user_segments() RPCで動的生成")

    print()

    # ══════════════════════════════════════
    #  総合結果
    # ══════════════════════════════════════
    elapsed = time.time() - t0
    print(f"{C.CY}{'─' * 55}{C.RST}")
    print(f"{C.B}📋 総合結果{C.RST}  {C.DIM}({elapsed:.1f}秒){C.RST}")
    print(f"{C.CY}{'─' * 55}{C.RST}")

    total = sum(cr.counts.values())
    print(f"  {C.G}✅ PASS:  {cr.counts['PASS']:>2} / {total}{C.RST}")
    print(f"  {C.Y}⚠️  WARN:  {cr.counts['WARN']:>2} / {total}{C.RST}")
    print(f"  {C.R}❌ FAIL:  {cr.counts['FAIL']:>2} / {total}{C.RST}")
    print(f"  {C.BL}ℹ️  INFO:  {cr.counts['INFO']:>2} / {total}{C.RST}")
    print(f"  {C.DIM}⏭️  SKIP:  {cr.counts['SKIP']:>2} / {total}{C.RST}")
    print()

    if cr.actions:
        print(f"{C.B}🔧 推奨アクション:{C.RST}")
        for i, a in enumerate(cr.actions, 1):
            print(f"  {i}. {a}")
        print()

    if cr.counts["FAIL"] > 0:
        print(f"{C.R}{C.B}⛔ 重大な不整合が検出されました{C.RST}\n")
        return 1
    elif cr.counts["WARN"] > 0:
        print(f"{C.Y}{C.B}⚡ 軽微な問題が検出されました{C.RST}\n")
        return 0
    else:
        print(f"{C.G}{C.B}✨ データ整合性は良好です{C.RST}\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
