#!/bin/bash
# mesh 阶段：blockMesh -> checkMesh -> decomposePar
set -eo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "$HERE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1] + '/contract.json', encoding='utf-8'))['run']
p = json.load(open('trial-params.json'))
print(f"BASHRC={c['foam_bashrc']}; NP={int(p.get('np', c['np']))}")
PY
)"
source "$BASHRC" > /dev/null 2>&1

blockMesh -noFunctionObjects > log.blockMesh 2>&1
grep -q "^End" log.blockMesh || { echo "FATAL: blockMesh failed"; tail -20 log.blockMesh; exit 5; }

checkMesh -noFunctionObjects > log.checkMesh 2>&1
grep -E "(Mesh OK|FAILED)" log.checkMesh | tail -3

decomposePar -force -time 0 -noFunctionObjects > log.decomposePar 2>&1
grep -q "^End" log.decomposePar || { echo "FATAL: decomposePar failed"; tail -10 log.decomposePar; exit 6; }

echo "mesh_ok"
