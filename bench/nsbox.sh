#!/bin/bash
# 每一方一个独立 PID 命名空间（无需 root）：本方的 pkill/killall 看不到别人的进程。
# 命名空间的 1 号进程是常驻的 sleep，所以杀掉智能体宿主（故障注入）不会连带杀掉它启动的求解器。
# 用法：. nsbox.sh；nsbox_create NAME → 写 $NSDIR/NAME.pid；nsbox_run NAME cmd...（在盒内执行）；nsbox_destroy NAME
NSDIR=${NSDIR:-$HOME/bench/ns}; mkdir -p "$NSDIR"
nsbox_create() {
  setsid unshare -Upfm --map-current-user --mount-proc sleep infinity < /dev/null > /dev/null 2>&1 &
  local U=$! C=""
  for i in $(seq 1 50); do C=$(pgrep -P $U -x sleep); [ -n "$C" ] && break; sleep 0.1; done
  [ -n "$C" ] || { echo "nsbox_create failed" >&2; return 1; }
  echo "$C" > "$NSDIR/$1.pid"
}
# --wd：nsenter 进入 mount 命名空间后默认把工作目录设成 /，必须显式带上调用方的当前目录
nsbox_run() { local N=$1; shift; nsenter -t "$(cat "$NSDIR/$N.pid")" -U -m -p --preserve-credentials --wd="$PWD" -- "$@"; }
nsbox_destroy() { local P; P=$(cat "$NSDIR/$1.pid" 2>/dev/null) && kill -9 "$P" 2>/dev/null; rm -f "$NSDIR/$1.pid"; }
