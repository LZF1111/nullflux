#!/bin/bash
# 无人值守链：等对照试验结束 → 对照复现基准才开搜索 → campaign 每轮 1 个 CFD，按轮次持续迭代。
# 用法: nohup bash run_chain.sh ROUNDS > ~/mto_repro/rsi_dist/chain.out 2>&1 &
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
ROUNDS=${1:-6}
W=/home/user/mto_repro/rsi_dist
while pgrep -f 'rsi.py submit seeds/s0_uniform211.py --control' > /dev/null; do sleep 300; done
STATE=$(python3 -c "import json; a=json.load(open('$W/archive.json')); print((a.get('control') or {}).get('state'))")
echo "$(date -Is) control state: $STATE"
if [ "$STATE" != "control_ok" ]; then echo "对照未复现基准，停止：先查流水线"; exit 1; fi
export HL_API_URL=http://127.0.0.1:18081/v1/chat/completions HL_MODEL=${HL_MODEL:-claude-opus-5-5}
python3 campaign.py --rounds "$ROUNDS" --per-round 4 --cfd-per-round 1
echo "$(date -Is) campaign done"; python3 rsi.py status
