#!/bin/bash
# solve 阶段：并行 twoPhaseEulerFoam -> reconstructPar -> writeCellCentres
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
NP="${NP:-4}"

echo "=== Running twoPhaseEulerFoam on $NP cores ==="
mpirun --bind-to none -np "$NP" twoPhaseEulerFoam -parallel > log.solver 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  echo "FATAL: solver exited $rc"; tail -30 log.solver; exit $rc
fi

echo "=== Reconstructing ==="
reconstructPar -noFunctionObjects > log.reconstruct 2>&1
grep -q "^End" log.reconstruct || { echo "WARN: reconstructPar issues"; tail -5 log.reconstruct; }

# Write cell centres so verify.py can map cell indices to (x,y)
postProcess -func writeCellCentres -time 0 -noFunctionObjects > log.cellCentres 2>&1 || true

echo "solve_done"
