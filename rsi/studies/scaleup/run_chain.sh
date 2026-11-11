#!/bin/bash
# 放大设计 RSI（商业 DMTO，2D 筛选）。对照 = 原文商业工况，必须复现 cases/comm2D 出口 KPI ±1 % 才搜索。
# 内置 CSTR 代理提议，不用 LLM。用法: nohup bash run_chain.sh ROUNDS >> ~/mto_repro/rsi_scale/chain.out 2>&1 &
HERE="$(cd "$(dirname "$0")" && pwd)"; RSI="$(cd "$HERE/../.." && pwd)"
ROUNDS=${1:-4}
export RSI_CLAIMS=${RSI_CLAIMS:-/home/user/mto_repro/rsi_claims.json}
cd "$RSI"
python3 -m core.cli scaleup init
python3 -m core.cli scaleup control || true
python3 -m core.cli scaleup run --staged 1 --speculative --rounds "$ROUNDS" --per-round 4 --slots "${SLOTS:-4}" --wait-s 600
echo "$(date -Is) scale-up study done"; python3 -m core.cli scaleup status
