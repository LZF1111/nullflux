#!/bin/bash
# solve 阶段（工况研究）：与分布板 stage_solve.sh 相同（stab/base t0 映射初场 → decomposePar → 并行续算），
# 但 mapFields 之后把 T.gas / T.particles 换回本工况的 0/ 文件（mapFields 会把内部场映射回源算例的 738 K），
# 并核对 U.gas inlet2 的 massFlowRate 仍是本工况的值。
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "$HERE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1] + '/config.json', encoding='utf-8'))
r = c['run']; p = json.load(open('trial-params.json'))
mdot = c['base']['inlet2_massFlowRate'] * float(p['feed_scale'])
print(f"SRC={r['src_case']}; BASHRC={r['foam_bashrc']}; T0={p['t0']}; NP={int(p['np'])}; MDOT={mdot:.8e}")
PY
)"
source "$BASHRC" > /dev/null 2>&1
set -eo pipefail
mkdir -p "$T0"
cp 0/* "$T0"/
mapFields "$SRC" -sourceTime "$T0" -consistent > log.mapFields 2>&1
grep -q "^End" log.mapFields || { echo "FATAL: mapFields failed"; tail -20 log.mapFields; exit 5; }
cp 0/T.gas 0/T.particles "$T0"/
python3 - "$T0/U.gas" "$MDOT" <<'PY' || { echo "FATAL: inlet2 massFlowRate lost after mapFields (want $MDOT)"; exit 7; }
import re, sys
s = open(sys.argv[1], 'rb').read().decode('latin-1')
m = re.search(r'inlet2\s*\{[^}]*?massFlowRate\s+constant\s+([0-9.eE+-]+)', s)
sys.exit(0 if m and abs(float(m.group(1)) / float(sys.argv[2]) - 1) < 1e-6 else 1)
PY
decomposePar -force -time "$T0" > log.decomposePar 2>&1
grep -q "^End" log.decomposePar || { echo "FATAL: decomposePar failed"; tail -20 log.decomposePar; exit 6; }
set +e
mpirun --bind-to none -np "$NP" reactingTwoPhaseEulerFoam -parallel
rc=$?
# 同分布板 stage_solve.sh：dynamicCode 里的符号链接换成文件副本（cfd_trial 证据禁止符号链接）
find dynamicCode -type l 2>/dev/null | while read -r l; do cp --remove-destination "$(readlink -f "$l")" "$l" || rm -f "$l"; done
exit $rc
