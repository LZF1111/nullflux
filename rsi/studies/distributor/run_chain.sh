#!/bin/bash
# 分布板 RSI 链（通用核心版，替换 rsi/distributor/run_chain.sh 的 campaign 部分）：
# 等旧流水线跑的对照结束 → control_ok 才开搜索 → core.cli distributor run --staged 1：
# 短算 1.5 s 筛掉明显更差的候选，其余晋级完整 3 s；按空闲核并行，最多 2 个同时（留 1 个 24 核槽给工况研究）。
# 用法: nohup bash run_chain.sh ROUNDS >> ~/mto_repro/rsi_dist/chain.out 2>&1 &
HERE="$(cd "$(dirname "$0")" && pwd)"; RSI="$(cd "$HERE/../.." && pwd)"
ROUNDS=${1:-6}
W=/home/user/mto_repro/rsi_dist
export RSI_CLAIMS=${RSI_CLAIMS:-/home/user/mto_repro/rsi_claims.json}
STATE=$(python3 -c "import json; a=json.load(open('$W/archive.json')); print((a.get('control') or {}).get('state'))")
echo "$(date -Is) core chain (speculative): control state now: $STATE"
if [ "$STATE" = "control_failed" ]; then echo "对照未复现基准，停止：先查流水线"; exit 1; fi
# 预跑：对照（旧流水线 rsi.py）还在跑时就开始搜索；候选结果等对照 control_ok 才判定，对照失败则作废
export HL_API_URL=http://127.0.0.1:18081/v1/chat/completions HL_MODEL=${HL_MODEL:-claude-opus-5-5}
cd "$RSI"
# SLOTS：同时在跑+排队的试验数。A/B 基准和 fine2 都不占核时用 3（3×24 + 留 8 = 80/96）
python3 -m core.cli distributor run --staged 1 --speculative --rounds "$ROUNDS" --per-round 4 --slots "${SLOTS:-2}" --wait-s 600
echo "$(date -Is) campaign done"; python3 -m core.cli distributor status --staged 1
