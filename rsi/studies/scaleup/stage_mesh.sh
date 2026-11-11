#!/bin/bash
# mesh 阶段（放大设计）：blockMesh → checkMesh（"Mesh OK" 必须出现在 stdout）→ setFields 堆积初始床层
HERE="$(cd "$(dirname "$0")" && pwd)"
BASHRC=$(python3 -c "import json;print(json.load(open('$HERE/config.json'))['run']['foam_bashrc'])")
source "$BASHRC" > /dev/null 2>&1
set -eo pipefail
blockMesh > log.blockMesh 2>&1 || { tail -30 log.blockMesh; exit 3; }
checkMesh
setFields > log.setFields 2>&1 || { tail -30 log.setFields; exit 4; }
grep -q "^End" log.setFields
