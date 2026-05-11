#!/usr/bin/env bash
# NullFlux 启动脚本 (by LZF)
# 用法:
#   ./start.sh                          # 默认端口 5174, 监听 0.0.0.0
#   ./start.sh --port 5180              # 指定端口
#   ./start.sh -p 5180                  # 同上
#   ./start.sh 5180                     # 同上 (首个数字)
#   ./start.sh --port 5180 --host 127.0.0.1
#   PORT=5180 ./start.sh                # 也支持环境变量
set -e
cd "$(dirname "$0")"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
export HOST="${HOST:-0.0.0.0}"
exec node server.bundle.mjs "$@"
