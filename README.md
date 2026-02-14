# Morning Hook SaaS

Stripchat配信管理SaaS — DM送信、チャット監視、売上分析、AIレポート

## Architecture

```
Chrome Extension (User PC)  →  FastAPI Backend (Railway)  →  Supabase (DB + Auth)
                                      ↕
                             Next.js Frontend (Vercel)  →  Claude API (AI)
```

## Quick Start

### 1. Supabase Setup
1. [supabase.com](https://supabase.com) でプロジェクト作成
2. SQL Editor で以下を実行:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_analytics_functions.sql`
3. Settings > API から URL, anon key, service role key, JWT secret を取得

### 2. Backend
```bash
cd backend
cp .env.example .env    # 環境変数を設定
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. Frontend
```bash
cd frontend
cp .env.local.example .env.local  # 環境変数を設定
npm install
npm run dev
```

### 4. Chrome Extension
1. `chrome://extensions/` → デベロッパーモード ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `chrome-extension/` を選択

## Project Structure

```
morninghook-saas/
├── backend/           # FastAPI (Python)
│   ├── main.py
│   ├── config.py
│   ├── routers/       # API endpoints (auth, dm, spy, analytics, ai, scripts, sync)
│   ├── services/      # Business logic (vip_checker, llm_engine)
│   └── models/        # Pydantic schemas
├── frontend/          # Next.js (TypeScript)
│   └── src/
│       ├── app/       # Pages (dashboard, spy, dm, analytics, ai, scripts, settings)
│       ├── components/ # UI components
│       ├── hooks/     # React hooks (realtime-spy, dm-queue)
│       ├── lib/       # API client, Supabase, utils
│       └── types/     # TypeScript types
├── chrome-extension/  # Manifest V3
│   ├── manifest.json
│   ├── background.js
│   └── (content scripts)
└── supabase/
    └── migrations/    # SQL schema + RPC functions
```

## Deploy

| Service | Platform | Command |
|---------|----------|---------|
| Backend | Railway | `railway up` in `/backend` |
| Frontend | Vercel | Connect GitHub repo, set root to `frontend/` |
| DB | Supabase | Run migrations in SQL Editor |
| Extension | Chrome Web Store | Package and submit |
