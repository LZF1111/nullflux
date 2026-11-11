@echo off
rem 启动 NullFlux（Windows）。端口：start.bat 5300
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要 Node.js 18 或更高版本：https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules call npm install --omit=dev --no-audit --no-fund
if not exist .env copy .env.example .env >nul
start "" http://127.0.0.1:5174/app
node server.js %*
