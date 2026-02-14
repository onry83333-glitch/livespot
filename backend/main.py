"""Morning Hook SaaS - FastAPI Backend"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

from routers import auth, dm, spy, sync, analytics, ai, scripts, reports, feed

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

# CORS
origins = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001").split(",")
origins = [o.strip() for o in origins]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
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

@app.get("/health")
async def health():
    return {"status": "ok", "service": "morninghook-api"}
