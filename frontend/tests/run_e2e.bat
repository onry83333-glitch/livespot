@echo off
REM ============================================================
REM Playwright E2E テスト実行バッチ
REM
REM 使い方:
REM   tests\run_e2e.bat              — 全テスト実行（headless）
REM   tests\run_e2e.bat --headed     — ブラウザ表示あり
REM   tests\run_e2e.bat --prod       — 本番URLに対して実行
REM ============================================================

cd /d "%~dp0.."

REM 日付フォルダ生成
for /f "tokens=1-3 delims=-" %%a in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd'"') do set TODAY=%%a-%%b-%%c
set SCREENSHOT_DIR=tests\screenshots\%TODAY%
if not exist "%SCREENSHOT_DIR%" mkdir "%SCREENSHOT_DIR%"

echo ============================================================
echo  Playwright E2E Test Runner
echo  Date: %TODAY%
echo  Screenshots: %SCREENSHOT_DIR%
echo ============================================================
echo.

REM 引数処理
set EXTRA_ARGS=
set BASE_URL=

if "%1"=="--headed" (
  set EXTRA_ARGS=--headed
  echo  Mode: HEADED ^(browser visible^)
) else if "%1"=="--prod" (
  set BASE_URL=https://livespot-rouge.vercel.app
  echo  Mode: PRODUCTION ^(%BASE_URL%^)
) else (
  echo  Mode: HEADLESS ^(default^)
)

echo.

REM テスト実行
if defined BASE_URL (
  set E2E_BASE_URL=%BASE_URL%
)

call npx playwright test %EXTRA_ARGS%

echo.
echo ============================================================
echo  Test complete. Screenshots saved to: %SCREENSHOT_DIR%
echo  Run 'npm run test:e2e:report' to view HTML report.
echo ============================================================
