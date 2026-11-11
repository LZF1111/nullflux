#!/usr/bin/env bash
# fetch_sources.sh — 接入官方 LBM 框架源码到 backplane/vendor/
# 用法:
#   ./fetch_sources.sh link  /path/to/palabos   # 登记本机已装 Palabos (软链)
#   ./fetch_sources.sh clone-palabos            # 浅克隆 Palabos
#   ./fetch_sources.sh clone-openlb             # 提示 OpenLB 获取方式
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor"
mkdir -p "$VENDOR"

case "${1:-help}" in
  link)
    SRC="${2:-}"
    if [[ -n "$SRC" && -d "$SRC/src" ]]; then
      ln -sfn "$SRC/src" "$VENDOR/src"
      [[ -d "$SRC/examples" ]] && ln -sfn "$SRC/examples" "$VENDOR/examples"
      echo "[ok] 已登记本机框架: $SRC -> $VENDOR"
    else
      echo "[warn] 未找到框架(需含 src/)。用法: ./fetch_sources.sh link /path/to/palabos"
    fi
    ;;
  clone-palabos)
    git clone --depth 1 https://gitlab.com/unigespc/palabos.git "$VENDOR/palabos" \
      && echo "[ok] Palabos -> $VENDOR/palabos" \
      || echo "[warn] 克隆失败(网络?) — 改用 link 登记本机 Palabos"
    ;;
  clone-openlb)
    echo "OpenLB 需从官网下载发行包: https://www.openlb.net/download/"
    echo "下载解压后: ./fetch_sources.sh link /path/to/olb-<ver>"
    ;;
  *)
    echo "用法: ./fetch_sources.sh [link <DIR> | clone-palabos | clone-openlb]"
    ;;
esac
ls -la "$VENDOR" 2>/dev/null || true
