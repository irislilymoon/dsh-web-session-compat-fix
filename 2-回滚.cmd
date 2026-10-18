@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  pause
  exit /b 1
)
node "%~dp0dsh-fix.mjs" --revert
echo.
pause
