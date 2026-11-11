#!/bin/bash
# solve 阶段：从已收敛的基准状态（stab/base t0）用 mapFields 映射初场 → decomposePar → 并行续算到 t0+duration。
# 求解输出直接进 stdout（cfd_trial.js 从中核对 End 与最终 Time）。不改网格。
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "$HERE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1] + '/contract.json', encoding='utf-8'))['run']
p = json.load(open('trial-params.json'))
print(f"SRC={c['src_case']}; BASHRC={c['foam_bashrc']}; T0={p['t0']}; NP={int(p['np'])}")
PY
)"
source "$BASHRC" > /dev/null 2>&1
set -eo pipefail
mkdir -p "$T0"
cp 0/* "$T0"/
mapFields "$SRC" -sourceTime "$T0" -consistent > log.mapFields 2>&1
grep -q "^End" log.mapFields || { echo "FATAL: mapFields failed"; tail -20 log.mapFields; exit 5; }
decomposePar -force -time "$T0" > log.decomposePar 2>&1
grep -q "^End" log.decomposePar || { echo "FATAL: decomposePar failed"; tail -20 log.decomposePar; exit 6; }
set +e
mpirun --bind-to none -np "$NP" reactingTwoPhaseEulerFoam -parallel
rc=$?
# coded 源/边界在 dynamicCode/*/lnInclude 里建指向 $FOAM_SRC 模板的符号链接；cfd_trial 证据禁止符号链接 → 换成文件副本
find dynamicCode -type l 2>/dev/null | while read -r l; do cp --remove-destination "$(readlink -f "$l")" "$l" || rm -f "$l"; done
exit $rc
