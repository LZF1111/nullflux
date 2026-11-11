#!/bin/bash
# 给 NUM-3D-007 细网格续算（fine2，64 核）占核：冒烟 b7d9ecad 结束 → fine2 启动之间的空档不让 RSI 调度器抢走这 64 核。
# 冒烟结束时登记 fine2（owner external），fine2 求解器真正跑起来（或已算到 121.8 s）就撤销，之后由 busy_cores() 计入。
# fine2 在 3 h 内没启动也撤销（不长期占核），日志里留记录。
HERE="$(cd "$(dirname "$0")" && pwd)"; RSI="$(cd "$HERE/../.." && pwd)"
FINE=/home/user/mto_repro/cases/pilot3D_fine
CL=${RSI_CLAIMS:-/home/user/mto_repro/rsi_claims.json}
fine_running() { pgrep -f reactingTwoPhaseEulerFoam | xargs -r -I{} readlink /proc/{}/cwd 2>/dev/null | grep -qx "$FINE"; }
fine_done() { ls -d "$FINE"/processor0/121.8* > /dev/null 2>&1; }
cd "$RSI"
echo "$(date -Is) wait for smoke b7d9ecad to end"
while fine_running; do sleep 120; done
python3 -m core.claims "$CL" add fine2 64 external 10800
echo "$(date -Is) smoke ended; fine2 claim added (64 cores, 3 h max)"
for i in $(seq 1 90); do
  if fine_running || fine_done; then break; fi
  sleep 120
done
python3 -m core.claims "$CL" remove fine2
if fine_running || fine_done; then echo "$(date -Is) fine2 running (or done): claim removed"
else echo "$(date -Is) WARNING fine2 did not start within 3 h: claim removed, cores released to RSI"; fi
