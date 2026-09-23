@echo off
setlocal
cd /d "%~dp0"
set "FRAMEBASE_GIT_DIR=C:\Users\kaigezhang\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd"
if not exist "%FRAMEBASE_GIT_DIR%\git.exe" (
  echo Git was not found at:
  echo %FRAMEBASE_GIT_DIR%\git.exe
  pause
  exit /b 1
)
set "PATH=%FRAMEBASE_GIT_DIR%;%PATH%"
start "" /D "%~dp0" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoExit
