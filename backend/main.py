"""Morning Hook SaaS - FastAPI Backend"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

from routers import auth, dm, spy, sync, analytics, ai, scripts, reports, feed, stt, competitive

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print("[LS] Morning Hook API starting...")
    yield
    # Shutdown
    print("[LS] Morning Hook API shutting down...")

app = FastAPI(
    title="Morning Hook API",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS（開発環境: ワイルドカード許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(dm.router, prefix="/api/dm", tags=["dm"])
app.include_router(spy.router, prefix="/api/spy", tags=["spy"])
app.include_router(sync.router, prefix="/api/sync", tags=["sync"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(ai.router, prefix="/api/ai", tags=["ai"])
app.include_router(scripts.router, prefix="/api/scripts", tags=["scripts"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(feed.router, prefix="/api/feed", tags=["feed"])
app.include_router(stt.router, prefix="/api/stt", tags=["stt"])
app.include_router(competitive.router, prefix="/api/competitive", tags=["Competitive Analysis"])

@app.get("/health")
async def health():
    return {"status": "ok", "service": "morninghook-api"}
