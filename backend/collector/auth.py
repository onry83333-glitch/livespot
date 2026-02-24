"""
Chrome Cookie自動抽出 + Stripchat API認証
方式A: ChromeのCookie DB（SQLite）からCookieを直接読み取り
"""

import base64
import ctypes
import ctypes.wintypes
import json
import logging
import sqlite3
import tempfile
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# パス設定
# ---------------------------------------------------------------------------
CHROME_USER_DATA = Path(
    r"C:\Users\onry8\AppData\Local\Google\Chrome\User Data"
)
CHROME_LOCAL_STATE = CHROME_USER_DATA / "Local State"
CHROME_COOKIE_DB = CHROME_USER_DATA / "Default" / "Network" / "Cookies"

STRIPCHAT_BASE = "https://stripchat.com"
STRIPCHAT_DOMAIN = ".stripchat.com"

# 取得対象Cookie
TARGET_COOKIES = ["stripchat_com_sessionId", "cf_clearance", "__cf_bm"]


# ---------------------------------------------------------------------------
# Windows DPAPI (ctypes)
# ---------------------------------------------------------------------------
class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _dpapi_decrypt(encrypted: bytes) -> bytes:
    """Windows DPAPIで復号"""
    blob_in = _DATA_BLOB(
        len(encrypted),
        ctypes.create_string_buffer(encrypted, len(encrypted)),
    )
    blob_out = _DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(blob_out),
    )
    if not ok:
        raise RuntimeError(
            f"DPAPI CryptUnprotectData failed (error={ctypes.GetLastError()})"
        )
    data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return data


# ---------------------------------------------------------------------------
# Chrome暗号化キー取得
# ---------------------------------------------------------------------------
def _get_chrome_encryption_key() -> bytes:
    """Local StateからChrome Cookie暗号化キー(AES-256-GCM)を取得"""
    with open(CHROME_LOCAL_STATE, "r", encoding="utf-8") as f:
        local_state = json.load(f)

    encrypted_key_b64 = local_state["os_crypt"]["encrypted_key"]
    encrypted_key = base64.b64decode(encrypted_key_b64)

    # 先頭5バイト "DPAPI" プレフィックスを除去してDPAPIで復号
    if encrypted_key[:5] != b"DPAPI":
        raise ValueError("Unexpected encrypted_key format (no DPAPI prefix)")

    return _dpapi_decrypt(encrypted_key[5:])


# ---------------------------------------------------------------------------
# Cookie値復号 (AES-256-GCM)
# ---------------------------------------------------------------------------
def _decrypt_cookie_value(encrypted_value: bytes, key: bytes) -> str:
    """Chrome暗号化Cookie値をAES-256-GCMで復号"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    # v10/v20 プレフィックス (3バイト)
    prefix = encrypted_value[:3]
    if prefix not in (b"v10", b"v20"):
        # 暗号化されていない旧形式 → そのまま返す
        try:
            return encrypted_value.decode("utf-8")
        except UnicodeDecodeError:
            return ""

    nonce = encrypted_value[3:15]       # 12バイト nonce
    ciphertext = encrypted_value[15:]   # 残り = 暗号文 + 16バイト GCM tag

    aesgcm = AESGCM(key)
    decrypted = aesgcm.decrypt(nonce, ciphertext, None)
    return decrypted.decode("utf-8")


# ---------------------------------------------------------------------------
# Cookie DB読み取り
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Windows CreateFileW によるロック回避コピー
# ---------------------------------------------------------------------------
def _win_copy_shared(src_path: str, dst_path: str) -> None:
    """
    Windows APIでFILE_SHARE_READ|WRITE|DELETEフラグ付きでファイルを開き、
    Chrome起動中でもCookie DBを読み取れるようにコピーする。
    """
    kernel32 = ctypes.windll.kernel32
    GENERIC_READ = 0x80000000
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004  # READ|WRITE|DELETE
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x00000080
    INVALID_HANDLE = ctypes.wintypes.HANDLE(-1).value

    kernel32.CreateFileW.restype = ctypes.wintypes.HANDLE
    handle = kernel32.CreateFileW(
        src_path,
        GENERIC_READ,
        FILE_SHARE_ALL,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        None,
    )

    if handle == INVALID_HANDLE:
        err = ctypes.GetLastError()
        raise OSError(f"CreateFileW failed (error={err})")

    try:
        # ファイルサイズ取得
        file_size = ctypes.wintypes.DWORD(0)
        kernel32.GetFileSize.restype = ctypes.wintypes.DWORD
        file_size = kernel32.GetFileSize(handle, None)

        # 読み取り
        buf = ctypes.create_string_buffer(file_size)
        bytes_read = ctypes.wintypes.DWORD(0)
        ok = kernel32.ReadFile(
            handle, buf, file_size, ctypes.byref(bytes_read), None
        )
        if not ok:
            err = ctypes.GetLastError()
            raise OSError(f"ReadFile failed (error={err})")

        # 書き込み
        with open(dst_path, "wb") as f:
            f.write(buf.raw[: bytes_read.value])
    finally:
        kernel32.CloseHandle(handle)


_SENTINEL = object()


def extract_chrome_cookies(
    domain: str = STRIPCHAT_DOMAIN,
    target_names: list[str] | None | object = _SENTINEL,
) -> dict[str, str]:
    """
    ChromeのCookie DBからStripchat関連Cookieを抽出。
    Chrome起動中でもDB lockを回避するためtempにコピーして読む。

    Args:
        target_names: 取得対象Cookie名リスト。
                      省略時=TARGET_COOKIES、None=全Cookie返却。
    Returns:
        {"cookie_name": "cookie_value", ...}
    """
    return_all = target_names is None
    if target_names is _SENTINEL:
        target_names = TARGET_COOKIES

    if not CHROME_COOKIE_DB.exists():
        raise FileNotFoundError(f"Cookie DB not found: {CHROME_COOKIE_DB}")

    key = _get_chrome_encryption_key()

    # Chrome起動中はDBがロックされる。3段階のフォールバックで読み取り:
    # 1) SQLite URI mode (immutable) — ファイルコピー不要
    # 2) Windows API (CreateFileW + 共有フラグ) でバイナリコピー
    # 3) 通常の open() でバイナリコピー
    cookies = {}
    db_path = str(CHROME_COOKIE_DB).replace("\\", "/")
    query = f"%{domain.lstrip('.')}%"

    # --- 方法1: SQLite URI immutable (ロック回避) ---
    conn = None
    try:
        uri = f"file:///{db_path}?mode=ro&immutable=1"
        conn = sqlite3.connect(uri, uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name, encrypted_value FROM cookies "
            "WHERE host_key LIKE ? ORDER BY last_access_utc DESC",
            (query,),
        )
        for name, encrypted_value in cursor.fetchall():
            if encrypted_value:
                value = _decrypt_cookie_value(encrypted_value, key)
                if value:
                    cookies[name] = value
        conn.close()
        logger.info("Cookie DB読み取り: SQLite immutable mode")
    except Exception as e1:
        if conn:
            conn.close()
        logger.warning(f"SQLite immutable失敗: {e1}")

        # --- 方法2: Windows CreateFileW (共有読み取り) でコピー ---
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".sqlite")
        tmp_path = tmp.name
        tmp.close()

        try:
            _win_copy_shared(str(CHROME_COOKIE_DB), tmp_path)
            conn = sqlite3.connect(tmp_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT name, encrypted_value FROM cookies "
                "WHERE host_key LIKE ? ORDER BY last_access_utc DESC",
                (query,),
            )
            for name, encrypted_value in cursor.fetchall():
                if encrypted_value:
                    value = _decrypt_cookie_value(encrypted_value, key)
                    if value:
                        cookies[name] = value
            conn.close()
            logger.info("Cookie DB読み取り: Windows共有コピー")
        except Exception as e2:
            logger.warning(f"Windows共有コピー失敗: {e2}")

            # --- 方法3: 通常 open() ---
            try:
                with open(CHROME_COOKIE_DB, "rb") as src:
                    with open(tmp_path, "wb") as dst:
                        dst.write(src.read())
                conn = sqlite3.connect(tmp_path)
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT name, encrypted_value FROM cookies "
                    "WHERE host_key LIKE ? ORDER BY last_access_utc DESC",
                    (query,),
                )
                for name, encrypted_value in cursor.fetchall():
                    if encrypted_value:
                        value = _decrypt_cookie_value(encrypted_value, key)
                        if value:
                            cookies[name] = value
                conn.close()
                logger.info("Cookie DB読み取り: 通常コピー")
            except Exception as e3:
                raise RuntimeError(
                    f"Cookie DB読み取り全方法失敗: "
                    f"immutable={e1}, win_copy={e2}, open={e3}"
                ) from e3
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    # target_names=None → 全Cookie返却
    if return_all:
        logger.info(f"全Cookie取得: {len(cookies)}件")
        return cookies

    found = {n: cookies[n] for n in target_names if n in cookies}
    missing = [n for n in target_names if n not in cookies]

    if found:
        logger.info(
            f"Cookie取得成功: {list(found.keys())} "
            f"({len(found)}/{len(target_names)})"
        )
    if missing:
        logger.warning(f"Cookie未検出: {missing}")

    return found


def build_cookie_header(cookies: dict[str, str]) -> str:
    """Cookie辞書からHTTPヘッダー文字列を生成"""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


# ---------------------------------------------------------------------------
# Stripchat API疎通テスト
# ---------------------------------------------------------------------------
async def verify_stripchat_api(
    cookies: dict[str, str],
    cast_name: str = "Risa_06",
) -> dict:
    """
    取得したCookieでStripchat APIを叩いて疎通確認。
    認証不要エンドポイントだがCookie付きで200が返ることを検証。

    Returns:
        {"ok": True/False, "status": int, "data": dict|None, "error": str|None}
    """
    url = f"{STRIPCHAT_BASE}/api/front/v2/models/username/{cast_name}/cam"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
        "Cookie": build_cookie_header(cookies),
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        try:
            resp = await client.get(url, headers=headers)
            data = resp.json() if resp.status_code == 200 else None

            if resp.status_code == 200:
                # レスポンス構造: {"user": {"user": {status, id, ...}}, "cam": {...}}
                inner = data.get("user", {}).get("user", {})
                status = inner.get("status", "unknown")
                model_id = inner.get("id", "?")
                logger.info(
                    f"API疎通OK: {cast_name} "
                    f"(status={status}, model_id={model_id})"
                )

            return {
                "ok": resp.status_code == 200,
                "status": resp.status_code,
                "data": data,
                "error": None if resp.status_code == 200 else resp.text[:200],
            }
        except Exception as e:
            logger.error(f"API疎通エラー: {e}")
            return {"ok": False, "status": 0, "data": None, "error": str(e)}


# ---------------------------------------------------------------------------
# 方式B: cookies.json から読み取り（Chrome拡張 → Backend API → ファイル）
# ---------------------------------------------------------------------------
COOKIE_JSON_PATH = Path(__file__).resolve().parent / "cookies.json"


def load_cookies_from_file(
    target_names: list[str] | None = None,
    max_age_minutes: int = 120,
) -> dict[str, str]:
    """
    Chrome拡張が書き出した cookies.json からCookieを読み取る。
    Chrome DBロックを完全回避する方式B。

    Args:
        target_names: 取得対象Cookie名リスト。None=全Cookie返却。
        max_age_minutes: ファイルの有効期限（分）。超過時はValueError。
    Returns:
        {"cookie_name": "cookie_value", ...}
    """
    if not COOKIE_JSON_PATH.exists():
        raise FileNotFoundError(f"cookies.json が見つかりません: {COOKIE_JSON_PATH}")

    data = json.loads(COOKIE_JSON_PATH.read_text(encoding="utf-8"))
    exported_at = data.get("exported_at")

    # 鮮度チェック
    if exported_at:
        from datetime import datetime, timezone, timedelta

        try:
            export_time = datetime.fromisoformat(exported_at)
            age = datetime.now(timezone.utc) - export_time
            if age > timedelta(minutes=max_age_minutes):
                logger.warning(
                    f"cookies.json が古い: {age} 経過 (上限 {max_age_minutes}分)"
                )
        except (ValueError, TypeError):
            pass

    cookies = data.get("cookies", {})
    if not cookies:
        raise ValueError("cookies.json にCookieデータがありません")

    logger.info(f"cookies.json 読み取り: {len(cookies)}件 (source={data.get('source', '?')})")

    if target_names is None:
        return cookies

    return {n: cookies[n] for n in target_names if n in cookies}


# ---------------------------------------------------------------------------
# 統合: Cookie取得 → 検証（方式B優先、フォールバック方式A）
# ---------------------------------------------------------------------------
async def get_authenticated_cookies() -> dict[str, str]:
    """
    方式B (cookies.json) を優先、失敗時に方式A (Chrome DB直接) にフォールバック。
    成功時はCookie辞書を返す。失敗時はValueErrorをraise。
    """
    # --- 方式B: cookies.json ---
    try:
        cookies = load_cookies_from_file()
        if cookies:
            result = await verify_stripchat_api(cookies)
            if result["ok"]:
                logger.info("Cookie取得: 方式B (cookies.json) 成功")
                return cookies
            logger.warning(f"方式B: cookies.json のCookieでAPI疎通失敗: {result['error']}")
    except (FileNotFoundError, ValueError) as e:
        logger.info(f"方式B スキップ: {e}")

    # --- 方式A: Chrome DB直接 (フォールバック) ---
    logger.info("方式A (Chrome DB直接) にフォールバック")
    cookies = extract_chrome_cookies()

    if not cookies:
        raise ValueError("Cookieが1つも取得できませんでした (方式A/B両方失敗)")

    result = await verify_stripchat_api(cookies)
    if not result["ok"]:
        raise ValueError(
            f"API疎通失敗 (status={result['status']}): {result['error']}"
        )

    return cookies


# ---------------------------------------------------------------------------
# CLI実行用テスト
# ---------------------------------------------------------------------------
async def _main():
    """テスト: cookies.json読み取り → Stripchat API疎通確認"""
    import sys

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    print("=" * 60)
    print("Cookie -> Stripchat API Test")
    print("=" * 60)

    # Step 1: cookies.json読み取り
    print(f"\n[1] Cookie file: {COOKIE_JSON_PATH}")

    try:
        cookies = load_cookies_from_file()
    except FileNotFoundError:
        print(f"\n[WARN] cookies.json not found. Trying Chrome DB fallback...")
        try:
            cookies = extract_chrome_cookies()
        except Exception as e:
            print(f"\n[FAIL] All cookie sources failed: {e}")
            sys.exit(1)
    except Exception as e:
        print(f"\n[FAIL] Cookie read error: {e}")
        sys.exit(1)

    print(f"\n[2] Cookies ({len(cookies)}):")
    for name in TARGET_COOKIES:
        if name in cookies:
            v = cookies[name]
            display = v[:20] + "..." if len(v) > 20 else v
            print(f"    {name} = {display}")
        else:
            print(f"    {name} = (missing)")

    # Step 2: API疎通
    cast_name = "Risa_06"
    print(f"\n[3] API test: {cast_name}")
    result = await verify_stripchat_api(cookies, cast_name)

    if result["ok"]:
        data = result["data"] or {}
        inner = data.get("user", {}).get("user", {})
        status = inner.get("status", "unknown")
        model_id = inner.get("id", "?")
        username = inner.get("username", "?")

        print(f"\n[OK] HTTP {result['status']}")
        print(f"    username: {username}")
        print(f"    model_id: {model_id}")
        print(f"    status:   {status}")
    else:
        print(f"\n[FAIL] HTTP {result['status']}")
        print(f"    error: {result['error']}")
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print("All checks passed.")
    print("=" * 60)


if __name__ == "__main__":
    import asyncio

    asyncio.run(_main())
