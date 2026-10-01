@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
start "Chess.io - Battle Grid (3000)" cmd /k node chessio.js battlegrid
start "Chess.io - Battle of the Kings (3001)" cmd /k node chessio.js kings
start "Chess.io - Pieces with Pieces (3002)" cmd /k node chessio.js pieces
start "Chess.io - Super Chess (3003)" cmd /k node chessio.js superchess
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
