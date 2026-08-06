@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Download Node.js, install it, then run this file again.
  pause
  exit /b 1
)
echo Starting Fruit Fuse Arena at http://localhost:3000
echo Press Ctrl+C to stop the server.
start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000"
node server.js
pause
