#!/bin/bash
# submit_all.sh — 并行提交9个静态配置到服务器，遵守核心数限制。
# 用法：bash submit_all.sh [--dry]
#
# 策略：每个CFD试验占用 NP=4 核；服务器总核心数由 nproc 决定；
# 保留 RESERVE 核给系统/其他进程。
# 轮询间隔60s，超时300min自动放弃等待。

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRY="${1:-}"
NP=4            # cores per trial (matches contract.json)
RESERVE=8       # cores to leave free
MAX_WAIT=300    # minutes before giving up on a slot

SEEDS=(
    seeds/s0_uniform.py
    seeds/s1_left.py
    seeds/s2_right.py
    seeds/s3_center.py
    seeds/s4_annular.py
    seeds/s5_mild_left.py
    seeds/s6_mild_right.py
    seeds/s7_left_center.py
    seeds/s8_right_center.py
)

busy_foam_cores() {
    # Count cores used by running OpenFOAM solvers on this host
    local n=0
    for cmd in /proc/[0-9]*/cmdline; do
        local name
        name=$(cut -d '' -f1 < "$cmd" 2>/dev/null | xargs -0 basename 2>/dev/null || true)
        [[ "$name" == *Foam ]] && n=$((n + NP))
    done
    echo "$n"
}

available_cores() {
    local total; total=$(nproc)
    local busy; busy=$(busy_foam_cores)
    echo $(( total - busy - RESERVE ))
}

submit_one() {
    local seed="$1"
    echo "  → Submitting $seed"
    if [[ "$DRY" == "--dry" ]]; then
        python3 "$HERE/rsi.py" submit "$HERE/$seed" --dry
    else
        # Run in background; redirect output to log
        local logfile="$HERE/logs/$(basename "$seed" .py).log"
        mkdir -p "$HERE/logs"
        python3 "$HERE/rsi.py" submit "$HERE/$seed" > "$logfile" 2>&1 &
        echo "    PID $! → $logfile"
    fi
}

echo "=== Bubble Column Phase 1: submitting ${#SEEDS[@]} static seeds ==="
echo "    NP=$NP  RESERVE=$RESERVE  nproc=$(nproc)"

for seed in "${SEEDS[@]}"; do
    waited=0
    while true; do
        avail=$(available_cores)
        if (( avail >= NP )); then
            submit_one "$seed"
            # Brief pause to let the new process register in /proc
            sleep 5
            break
        fi
        if (( waited >= MAX_WAIT )); then
            echo "  TIMEOUT waiting for cores; skip $seed"
            break
        fi
        echo "  Waiting for cores (avail=$avail < NP=$NP)... sleep 60s"
        sleep 60
        waited=$((waited + 1))
    done
done

echo ""
echo "=== All seeds submitted (or skipped). Monitor with: ==="
echo "    watch -n 30 'python3 $HERE/rsi.py status'"
echo "    tail -f $HERE/logs/*.log"
