#!/bin/bash
# solve 阶段（放大设计）：decomposePar → 并行求解。完整日志写 log.solver（结束后压缩），
# stdout 只转发 Time / End / 报错行（cfd_trial 据此判 End 与终止时刻，免得每个试验几百 MB 日志）。
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 - "$HERE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1] + '/config.json', encoding='utf-8')); p = json.load(open('trial-params.json'))
print(f"BASHRC={c['run']['foam_bashrc']}; NP={int(p['np'])}")
PY
)"
source "$BASHRC" > /dev/null 2>&1
decomposePar -force > log.decomposePar 2>&1 || { tail -20 log.decomposePar; exit 6; }
grep -q "^End" log.decomposePar || { echo "FATAL: decomposePar failed"; exit 6; }
mpirun --bind-to none -np "$NP" reactingTwoPhaseEulerFoam -parallel 2>&1 | tee log.solver \
  | grep --line-buffered -aE '^Time = |^End$|FATAL|sigFpe|MPI_ABORT'
rc=${PIPESTATUS[0]}
gzip -f log.solver
# cfd_trial 证据禁止符号链接：dynamicCode 里的链接换成文件副本
find dynamicCode -type l 2>/dev/null | while read -r l; do cp --remove-destination "$(readlink -f "$l")" "$l" || rm -f "$l"; done
exit $rc
