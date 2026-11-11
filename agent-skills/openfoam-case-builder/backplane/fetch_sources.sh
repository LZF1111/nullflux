#!/usr/bin/env bash
# fetch_sources.sh — 重新拉取/更新两套官方 OpenFOAM 源码到 backplane/vendor/
# 说明: 本 skill 已内置 OpenFOAM-10/ 与 OpenFOAM-v2306/ 两套完整源码, 通常无需再跑此脚本。
#       仅当 vendor/ 被清空或想更新版本时使用。
# 用法:
#   ./fetch_sources.sh status     # 查看已内置的两套源码
#   ./fetch_sources.sh clone      # 重新浅克隆 OF-10 + ESI(v2306镜像)
#   ./fetch_sources.sh link       # 软链本机已装 OpenFOAM ($WM_PROJECT_DIR)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor"
mkdir -p "$VENDOR"

show_status() {
  for v in OpenFOAM-10 OpenFOAM-v2306; do
    if [ -d "$VENDOR/$v/applications/solvers" ]; then
      echo "[ok] $v  (含 solvers/src/tutorials)"
    else
      echo "[--] $v  缺失, 可用 clone 重新拉取"
    fi
  done
}

mode="${1:-status}"
case "$mode" in
  status) show_status ;;
  clone)
    # Foundation 版 (经典 simpleFoam/interFoam)
    git -c core.longpaths=true clone --depth 1 --branch version-10 \
      https://github.com/OpenFOAM/OpenFOAM-10.git "$VENDOR/OpenFOAM-10" \
      || echo "[warn] OF-10 克隆失败(网络?)"
    # ESI 版 (v2306, 与 v2406 同系) — 可匿名访问的镜像
    git -c core.longpaths=true clone --depth 1 \
      https://e.coding.net/dyfluid/OpenFOAM/OpenFOAM-v2306.git "$VENDOR/OpenFOAM-v2306" \
      || echo "[warn] ESI 克隆失败(网络?)"
    show_status
    ;;
  link)
    if [ -n "$WM_PROJECT_DIR" ] && [ -d "$WM_PROJECT_DIR" ]; then
      dst="$VENDOR/OpenFOAM-local"; mkdir -p "$dst"
      ln -sfn "$WM_PROJECT_DIR/src" "$dst/src"
      ln -sfn "$WM_PROJECT_DIR/tutorials" "$dst/tutorials"
      ln -sfn "$WM_PROJECT_DIR/applications" "$dst/applications"
      echo "[ok] 已登记本机 OpenFOAM: $WM_PROJECT_DIR -> $dst"
    else
      echo "[warn] 未检测到 \$WM_PROJECT_DIR。请先 source OpenFOAM 的 etc/bashrc，或改用 clone。"
      exit 1
    fi
    ;;
  *) echo "用法: $0 [status|clone|link]"; exit 2;;
esac
