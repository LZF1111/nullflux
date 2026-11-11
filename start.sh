#!/usr/bin/env bash
# 启动 CFDriver。端口：./start.sh 5300 或 PORT=5300 ./start.sh；对局域网开放加 --host 0.0.0.0
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund
[ -f .env ] || cp .env.example .env
exec node server.js "$@"
