@echo off
if "%1"=="start" (
  pm2 start ecosystem.config.cjs
  pm2 save
  echo Collector started and saved.
) else if "%1"=="stop" (
  pm2 stop sls-collector
  echo Collector stopped.
) else if "%1"=="restart" (
  pm2 restart sls-collector
  echo Collector restarted.
) else if "%1"=="logs" (
  pm2 logs sls-collector --lines 50
) else if "%1"=="status" (
  pm2 status
) else if "%1"=="startup" (
  pm2 startup
  pm2 save
  echo Startup hook installed.
) else if "%1"=="flush" (
  pm2 flush sls-collector
  echo Logs flushed.
) else (
  echo Usage: pm2.bat [start^|stop^|restart^|logs^|status^|startup^|flush]
  echo.
  echo   start    - Start collector in background
  echo   stop     - Stop collector
  echo   restart  - Restart collector
  echo   logs     - Show recent logs
  echo   status   - Show PM2 process status
  echo   startup  - Install Windows auto-start hook
  echo   flush    - Clear log files
)
