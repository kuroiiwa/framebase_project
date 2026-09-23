@echo off
setlocal
title Framebase Local Server - Close this window to stop
cd /d "%~dp0"

set "FRAMEBASE_NODE=C:\Users\kaigezhang\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
set "FRAMEBASE_SERVER=%~dp0node_modules\.bin\vinext.CMD"
set "PATH=%FRAMEBASE_NODE%;%PATH%"

if not exist "%FRAMEBASE_NODE%\node.exe" (
  echo [Framebase] Node.js runtime was not found.
  echo Please open this project in Codex once, then try again.
  pause
  exit /b 1
)

if not exist "%FRAMEBASE_SERVER%" (
  echo [Framebase] Local server was not found.
  echo Please open this project in Codex once, then try again.
  pause
  exit /b 1
)

if not exist "%~dp0dist\server\index.js" (
  echo [Framebase] The optimized application build was not found.
  echo Please open this project in Codex once to rebuild it, then try again.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo    Framebase local server is starting...
echo    The browser will open automatically at http://localhost:3000
echo    LAN sharing settings: http://localhost:3000/lan
echo.
echo    Close this window to stop Framebase.
echo  ============================================================
echo.

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "$readyUrl='http://127.0.0.1:3001/'; for ($attempt=0; $attempt -lt 120; $attempt++) { try { $result=Invoke-WebRequest -UseBasicParsing -Method Head -Uri $readyUrl -TimeoutSec 1; if ($result.StatusCode -lt 500) { Start-Process 'http://localhost:3000'; break } } catch {}; Start-Sleep -Milliseconds 150 }"
call "%FRAMEBASE_NODE%\node.exe" "%~dp0server\framebase-lan-server.mjs"

echo.
echo Framebase has stopped. Press any key to close this window.
pause >nul
exit /b 0
