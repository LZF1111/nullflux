#!/usr/bin/env bash
# fetch_sources.sh — 重新拉取/更新官方 LAMMPS 源码到 backplane/vendor/
# 说明: 本 skill 已内置 lammps-official/{src,doc}, 通常无需再跑。
#       仅当 vendor/ 被清空、想更新版本、或想补 potentials/ 时使用。
# 用法:
#   ./fetch_sources.sh status                # 查看已内置源码
#   ./fetch_sources.sh clone                 # git clone 官方仓 (src+doc, 需网)
#   ./fetch_sources.sh link  /path/to/lammps # 软链本机 LAMMPS (含 potentials/)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/vendor/lammps-official"
mkdir -p "$VENDOR"

show_status() {
  for d in src doc; do
    if [ -d "$VENDOR/$d" ]; then echo "[ok] lammps-official/$d"; else echo "[--] lammps-official/$d 缺失"; fi
  done
  [ -d "$VENDOR/potentials" ] && echo "[ok] potentials (已 link)" || echo "[--] potentials 未接入(生成时按官方命名引用即可)"
}

case "${1:-status}" in
  status) show_status ;;
  clone)
    tmp="$(mktemp -d)"
    git clone --depth 1 https://github.com/lammps/lammps.git "$tmp/lammps" \
      || { echo "[warn] 克隆失败(网络?)"; exit 1; }
    cp -r "$tmp/lammps/src" "$VENDOR/src"
    cp -r "$tmp/lammps/doc" "$VENDOR/doc"
    [ -f "$tmp/lammps/LICENSE" ] && cp "$tmp/lammps/LICENSE" "$VENDOR/"
    rm -rf "$tmp"
    show_status
    ;;
  link)
    LMP="${2:-$LAMMPS_ROOT}"
    if [ -n "$LMP" ] && [ -d "$LMP/src" ]; then
      ln -sfn "$LMP/src" "$VENDOR/src"
      ln -sfn "$LMP/doc" "$VENDOR/doc"
      [ -d "$LMP/potentials" ] && ln -sfn "$LMP/potentials" "$VENDOR/potentials"
      echo "[ok] 已登记本机 LAMMPS: $LMP"
    else
      echo "[warn] 未找到 LAMMPS(需含 src/)。用法: ./fetch_sources.sh link /path/to/lammps"
      exit 1
    fi
    ;;
  *) echo "用法: $0 [status|clone|link <LAMMPS_DIR>]"; exit 2;;
esac
