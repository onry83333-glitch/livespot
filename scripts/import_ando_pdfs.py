"""
PDFファイルからテキストを抽出し、cast_knowledgeに保存するスクリプト
安藤・ふみの原著データをLLMペルソナシミュレーション用に取り込む
"""
import sys
import os
import json
import urllib.request
import urllib.error

# Windows UTF-8出力
sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)
sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', buffering=1)

import fitz  # pymupdf

SUPABASE_URL = "https://ujgbhkllfeacbgpdbjto.supabase.co"
SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ"

# ファイル分類マッピング
FILE_CLASSIFICATIONS = {
    "月刊あんどう": {"author": "安藤", "category": "monthly"},
    "月間あんどう": {"author": "安藤", "category": "monthly"},
    "欲情、扇動、誘導のためのコンテンツメイキング": {"author": "安藤", "category": "method"},
    "大量生産型脱却のためのキャラクターメイキング": {"author": "安藤", "category": "method"},
    "ファンつくりの視点": {"author": "安藤", "category": "method"},
    "【詰んだ": {"author": "ふみ", "category": "experience"},
    "【ファンクラブ体験記】": {"author": "ふみ", "category": "experience"},
}

def classify_file(filename):
    for key, meta in FILE_CLASSIFICATIONS.items():
        if key in filename:
            return meta["author"], meta["category"]
    return "不明", "unknown"

def extract_text(pdf_path):
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text

def supabase_insert(data):
    url = f"{SUPABASE_URL}/rest/v1/cast_knowledge"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    payload = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  ERROR: {e.code} {body}", file=sys.stderr)
        return e.code

CAST_ID = 2  # hanshakun（キャスト横断ナレッジだが、cast_idは必須なのでhanshakunに紐付け）
ACCOUNT_ID = "940e7248-1d73-4259-a538-56fdaea9d740"

def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else None
    if not folder:
        print("Usage: python import_ando_pdfs.py <PDF_FOLDER_PATH>")
        sys.exit(1)

    cast_id = CAST_ID
    account_id = ACCOUNT_ID
    print(f"cast_id: {cast_id}")
    print(f"account_id: {account_id}")
    print()

    # PDFファイル一覧
    pdf_files = sorted([f for f in os.listdir(folder) if f.lower().endswith(".pdf")])
    print(f"PDFファイル数: {len(pdf_files)}")
    print()

    results = []
    for file_idx, fname in enumerate(pdf_files):
        path = os.path.join(folder, fname)
        author, category = classify_file(fname)
        print(f"処理中: {fname}")
        print(f"  分類: author={author}, category={category}")

        text = extract_text(path)
        char_count = len(text)
        print(f"  抽出文字数: {char_count}")

        if char_count < 10:
            print(f"  SKIP: テキストが少なすぎます")
            results.append({"file": fname, "chars": char_count, "status": "skipped"})
            continue

        data = {
            "cast_id": cast_id,
            "account_id": account_id,
            "report_type": "post_session",
            "knowledge_type": "marketer_persona_source",
            "period_start": f"2025-01-01T00:{file_idx:02d}:00Z",
            "metrics_json": {
                "source_file": fname,
                "author": author,
                "category": category,
                "char_count": char_count,
            },
            "insights_json": {
                "content": text,
                "source_file": fname,
                "author": author,
                "category": category,
            },
        }

        status = supabase_insert(data)
        status_str = "OK" if status in (200, 201) else f"ERROR({status})"
        print(f"  保存: {status_str}")
        results.append({"file": fname, "chars": char_count, "status": status_str})
        print()

    # サマリ
    print("=" * 60)
    print(f"処理完了: {len(results)}件")
    print()
    total_chars = 0
    for r in results:
        total_chars += r["chars"]
        print(f"  {r['status']:10s} {r['chars']:>8,}文字  {r['file']}")
    print(f"\n  合計文字数: {total_chars:,}")

if __name__ == "__main__":
    main()
