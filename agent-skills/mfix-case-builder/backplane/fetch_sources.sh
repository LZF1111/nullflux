#!/usr/bin/env bash
# fetch_sources.sh — 接入官方 MFiX 源码到 backplane/vendor/MFiX/
# 用法:
#   ./fetch_sources.sh link [MFIX_HOME]   # 登记本机已装 MFiX (零下载)
#   ./fetch_sources.sh clone               # 从官方 GitLab 浅克隆 (需网)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/MFiX"
mkdir -p "$VENDOR"
mode="${1:-link}"

case "$mode" in
  link)
    HOME_DIR="${2:-$MFIX_HOME}"
    if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR/model" ]; then
      ln -sfn "$HOME_DIR/model" "$VENDOR/model"
      [ -d "$HOME_DIR/tutorials" ] && ln -sfn "$HOME_DIR/tutorials" "$VENDOR/tutorials"
      [ -d "$HOME_DIR/doc" ] && ln -sfn "$HOME_DIR/doc" "$VENDOR/doc"
      echo "[ok] 已登记本机 MFiX: $HOME_DIR -> $VENDOR"
    else
      echo "[warn] 未找到 MFiX 安装(需含 model/)。用法: $0 link /path/to/mfix 或设 \$MFIX_HOME"
      exit 1
    fi
    ;;
  clone)
    # 官方 GitLab (可能需账号/镜像); 若失败改用 link 登记本机安装。
    git clone --depth 1 https://mfix.netl.doe.gov/gitlab/develop/mfix.git "$VENDOR/mfix" \
      || echo "[warn] 克隆失败(网络/权限?) — 改用 link 登记本机 MFiX 安装"
    ;;
  *) echo "用法: $0 [link [MFIX_HOME]|clone]"; exit 2;;
esac
ls -la "$VENDOR"
