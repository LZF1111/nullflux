#!/bin/bash
# mesh 阶段：复制开孔前网格（plate faceZone 仍是内部面）→ 按 holes.json 选挡板面 → createBaffles →
# patch 改名 → mainZone / reactZone（DEV-3D-005 进气室屏蔽）→ checkMesh（stdout 必须有 Mesh OK）。
# 与 cases/pilot3D/Allmesh 后半段一致；snappy 部分不重做，所有候选共用同一套底网格，差别只在开孔面。
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "$HERE" <<'PY'
import json, sys
r = json.load(open(sys.argv[1] + '/contract.json', encoding='utf-8'))['run']
print(f"PRE={r['prebaffle_mesh']}; BASHRC={r['foam_bashrc']}")
PY
)"
source "$BASHRC" > /dev/null 2>&1
set -eo pipefail
[ -f holes.json ] || { echo "FATAL: holes.json missing"; exit 2; }
rm -rf constant/polyMesh
cp -r "$PRE" constant/polyMesh
rm -rf constant/polyMesh/sets && mkdir -p constant/polyMesh/sets
python3 "$HERE/plate_from_holes.py"
topoSet > log.topoSet 2>&1
createBaffles -overwrite > log.createBaffles 2>&1
sed -i -E 's/^(\s*)reactor_(walls|inlet1|inlet2|inlet3|outlet4|outlet5)\s*$/\1\2/' constant/polyMesh/boundary
topoSet -dict system/topoSetDict.zones > log.topoSetZones 2>&1
topoSet -dict system/topoSetDict.react > log.topoSetReact 2>&1
for p in plateTop plateBottom inlet2 outlet5; do
  grep -q "^\s*$p\s*$" constant/polyMesh/boundary || { echo "FATAL: patch $p missing after baffles"; exit 3; }
done
checkMesh -constant 2>&1 | tee log.checkMesh | grep -E "cells:|non-orthogonality Max|Max skewness|Mesh OK|Failed|FATAL" || true
grep -q "^\s*Mesh OK" log.checkMesh || { echo "checkMesh did not report Mesh OK"; exit 4; }
