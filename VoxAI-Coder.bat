@echo off
REM VoxAI Coder launcher - double-click to run
REM No admin needed. Installs deps on first run, then starts the app.

cd /d "%~dp0voxai-coder"

where node >nul 2>nul
if errorlevel 1 (
  echo [VoxAI] Node.js not found. Install it from https://nodejs.org/ then re-run this file.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [VoxAI] First run - installing dependencies, this takes a minute...
  call npm.cmd install
  if errorlevel 1 (
    echo [VoxAI] npm install failed. Try running: npm install   manually in this folder.
    pause
    exit /b 1
  )
)

echo [VoxAI] Starting VoxAI Coder...
call npx.cmd electron .
if errorlevel 1 (
  echo.
  echo [VoxAI] App exited with an error. See output above.
  pause
)
