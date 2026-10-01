@echo off
setlocal
title Chess.io - Super Chess (port 3003)

rem Run from the folder this .bat lives in (put it next to chessio.js).
cd /d "%~dp0"

rem Optional: pass a different port as the first argument, e.g. start-super-chess.bat 3010
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3003"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install it from https://nodejs.org ^(LTS is fine^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "chessio.js" (
  echo.
  echo   Could not find chessio.js in:
  echo   %CD%
  echo   Put start-super-chess.bat in the same folder as chessio.js.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Super Chess on http://localhost:%PORT%
echo   Close this window ^(or press Ctrl+C^) to stop the server.
echo.

rem Open the browser a moment after the server has had time to boot.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"

node chessio.js superchess %PORT%

echo.
echo   Server stopped ^(exit code %errorlevel%^).
pause
endlocal
