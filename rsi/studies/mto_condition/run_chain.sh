#!/bin/bash
# MTO 工况研究（通用路径验证）：低优先级，reserve 24 核 → 只在分布板和细网格都用不满时才拿到一个 24 核槽。
# 对照（基准工况 1.0 × 738 K）先跑，复现 KPI ±1 % 才搜索；内置 CSTR 代理提议，不用 LLM。
# 用法: nohup bash run_chain.sh ROUNDS >> ~/mto_repro/rsi_cond/chain.out 2>&1 &
HERE="$(cd "$(dirname "$0")" && pwd)"; RSI="$(cd "$HERE/../.." && pwd)"
ROUNDS=${1:-2}
export RSI_CLAIMS=${RSI_CLAIMS:-/home/user/mto_repro/rsi_claims.json}
cd "$RSI"
python3 -m core.cli mto_condition init
python3 -m core.cli mto_condition control || true
python3 -m core.cli mto_condition run --rounds "$ROUNDS" --per-round 3 --slots 2 --reserve 24 --wait-s 600
echo "$(date -Is) condition study done"; python3 -m core.cli mto_condition status
