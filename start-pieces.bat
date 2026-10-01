@echo off
title Chess.io - Pieces with Pieces (port 3002)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node chessio.js pieces
echo.
echo Server stopped.
pause
