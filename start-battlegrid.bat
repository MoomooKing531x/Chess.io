@echo off
title Chess.io - Battle Grid (port 3000)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node chessio.js battlegrid
echo.
echo Server stopped.
pause
