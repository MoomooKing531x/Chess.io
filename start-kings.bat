@echo off
title Chess.io - Battle of the Kings (port 3001)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node chessio.js kings
echo.
echo Server stopped.
pause
