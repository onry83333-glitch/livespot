@echo off
chcp 65001 >nul
title Strip Live Spot - Bot Launcher

echo ========================================
echo  Strip Live Spot Bot Launcher
echo  Domain: pseudofinally-glaiked-john.ngrok-free.dev
echo ========================================
echo.

:: Check ngrok is installed
where ngrok >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] ngrok not found. Install: https://ngrok.com/download
    pause
    exit /b 1
)

echo [1/2] Starting FastAPI backend...
start "FastAPI Backend" cmd /k "cd /d C:\dev\livespot\backend && set PYTHONIOENCODING=utf-8 && set PYTHONUTF8=1 && python -m uvicorn main:app --reload --port 8000"

:: Wait for backend to start
timeout /t 3 /nobreak >nul

echo [2/2] Starting ngrok tunnel (fixed domain)...
start "ngrok Tunnel" cmd /k "ngrok http 8000 --domain pseudofinally-glaiked-john.ngrok-free.dev"

echo.
echo ========================================
echo  All services started!
echo  Backend:  http://localhost:8000
echo  Public:   https://pseudofinally-glaiked-john.ngrok-free.dev
echo ========================================
echo.
echo Chrome extension will auto-connect to the fixed domain.
echo Press any key to exit this launcher...
pause >nul
