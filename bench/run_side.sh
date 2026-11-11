#!/bin/bash
# 跑 A/B 的一方，全程录制。用法: run_side.sh {cfdriver|opencode} TASK RUN_ID
# 产物在 ~/bench/runs/RUN_ID/：work/（工作目录）、events.jsonl（带墙钟时间戳的事件流）、samples.jsonl（30 s 一次服务器采样）、
# meta.json（起止时间、版本、模型）、judge.json（判定脚本结果）。两边用同一份任务描述、同一个模型通路、同样的 8 核上限。
SIDE=$1; TASK=$2; RID=$3
B=$HOME/bench; R=$B/runs/$RID; W=$R/work
mkdir -p "$W"; cp "$B/tasks/$TASK.md" "$R/task.md"
T0=$(date +%s.%N)
echo "{\"side\":\"$SIDE\",\"task\":\"$TASK\",\"run\":\"$RID\",\"t0\":$T0,\"model\":\"claude-opus-5-5\",\"cores_cap\":${CORES_CAP:-8}}" > "$R/meta.json"
# 服务器采样：本方工作目录下的求解进程数、Time、Courant
( while :; do
    n=0; tm=""; co=""
    # 只数求解器本身（argv0 以 Foam 结尾，cwd 在本方目录下）
    for p in /proc/[0-9]*; do a=$(tr '\0' '\n' < $p/cmdline 2>/dev/null | head -1); case "${a##*/}" in *Foam) case "$(readlink $p/cwd 2>/dev/null)" in "$W"*) n=$((n+1));; esac;; esac; done
    L=$(find "$W" -name 'log*' -newermt '-2 min' -type f 2>/dev/null | head -1)
    [ -n "$L" ] && { tm=$(tail -c 20000 "$L" | grep -a '^Time = ' | tail -1 | cut -c8-); co=$(tail -c 20000 "$L" | grep -a 'Courant Number' | tail -1 | awk '{print $NF}'); }
    echo "{\"t\":$(date +%s.%N),\"procs\":$n,\"time\":\"$tm\",\"courant\":\"$co\",\"load\":\"$(cut -d' ' -f1 /proc/loadavg)\"}" >> "$R/samples.jsonl"
    sleep 30
  done ) & SAMP=$!
trap 'kill $SAMP 2>/dev/null' EXIT
source /home/user/OpenFOAM/OpenFOAM-v2306/etc/bashrc >/dev/null 2>&1 || true
cd "$W"
# 每方一个 PID 命名空间：同机并行的多次运行互不可见（一方的 pkill 不会误杀另一方的求解器）
. $B/nsbox.sh; nsbox_create "$RID" || exit 1
trap 'kill $SAMP 2>/dev/null; nsbox_destroy "$RID"' EXIT
if [ "$SIDE" = opencode ]; then
  . $B/oc_env.sh
  # 每次运行独立的配置/数据目录和后台服务端口，并行运行不共用一个服务
  mkdir -p "$R/oc_config/opencode" "$R/oc_state"; cp -r $B/oc_home/data "$R/oc_data"
  cp $B/oc_home/config/opencode/opencode.json "$R/oc_config/opencode/opencode.json"
  export XDG_CONFIG_HOME=$R/oc_config XDG_DATA_HOME=$R/oc_data XDG_STATE_HOME=$R/oc_state
  OCP=${OC_PORT:-$(( 49500 + RANDOM % 400 ))}
  # --format json：每个事件一行 JSON（工具调用、文本、用量），自己补墙钟时间戳
  # 任务从 stdin 给：放在命令行参数里时，智能体自己 pkill -f pimpleFoam 会把 opencode run 本身也匹配掉
  nsbox_run "$RID" bash -c 'opencode service set port '$OCP' >/dev/null 2>&1; exec opencode run "$@"' _ --auto --format json --title "$RID" -m relay/claude-opus-5-5 < "$R/task.md" 2> "$R/stderr.log" \
    | while IFS= read -r line; do printf '{"t":%s,"e":%s}\n' "$(date +%s.%N)" "$line"; done >> "$R/events.jsonl"
  SID=$(grep -o '"sessionID":"[^"]*"' "$R/events.jsonl" | head -1 | cut -d'"' -f4)
  [ -n "$SID" ] && nsbox_run "$RID" opencode session export "$SID" > "$R/session_export.json" 2>>"$R/stderr.log"
else
  # CFDriver：独立副本 ~/bench/cfdriver（端口 5310，workspace = 本次 work/，不接管别人的求解进程），不碰 5300 上的工作台
  # CFD_COPY/CFD_PORT 可指定另一份副本（新一轮用新版本，不影响正在跑的旧副本）
  C=$B/${CFD_COPY:-cfdriver}; P=${CFD_PORT:-5310}
  python3 -c "import json;m=json.load(open('$R/meta.json'));m['cfdriver_copy']='$C';m['cfdriver_sha']='$(sha1sum $C/server.js | cut -c1-12)';json.dump(m,open('$R/meta.json','w'))"
  python3 - "$C/settings.json" "$W" <<'EOF'
import json, sys
p, w = sys.argv[1], sys.argv[2]; s = json.load(open(p))
s.update(workspace=w, projects=[dict(path=w, name='bench')], adoptExternalRuns=False, foamMode=True)
json.dump(s, open(p, 'w'), indent=2)
EOF
  rm -f "$C/runs.json" "$C/tasks/"*.json 2>/dev/null
  ( cd "$C" && nsbox_run "$RID" node server.js --host 127.0.0.1 --port $P > "$R/cfdriver_server.log" 2>&1 ) & SRV=$!
  trap 'kill $SAMP $SRV 2>/dev/null; nsbox_destroy "$RID"' EXIT
  for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$P/ && break; sleep 2; done
  cp $B/drive_cfdriver.mjs $C/test/bench_drive.mjs
  (cd $C && CFD_PORT=$P node test/bench_drive.mjs "$R" 2>> "$R/stderr.log")
  cp -r "$C/tasks" "$R/cfdriver_tasks" 2>/dev/null
fi
T1=$(date +%s.%N)
# 判定 1：智能体宣布完成的那一刻（主判定）
python3 $B/judge_${TASK,,}.py "$W" > "$R/judge.out" 2>&1; cp "$W/judge.json" "$R/judge.json" 2>/dev/null
# 判定 2：智能体留下的求解进程自己跑完后再判一次（只作参考，记录"它走了以后算例能否自己跑完"）
nsolv() { n=0; for p in /proc/[0-9]*; do a=$(tr '\0' '\n' < $p/cmdline 2>/dev/null | head -1); case "${a##*/}" in *Foam) case "$(readlink $p/cwd 2>/dev/null)" in "$W"*) n=$((n+1));; esac;; esac; done; echo $n; }
while [ "$(nsolv)" != 0 ]; do sleep 30; done
T2=$(date +%s.%N)
python3 $B/judge_${TASK,,}.py "$W" > "$R/judge_after.out" 2>&1; cp "$W/judge.json" "$R/judge_after_orphans.json" 2>/dev/null; cp "$R/judge.json" "$W/judge.json" 2>/dev/null
python3 - "$R" "$T1" "$T2" <<'EOF'
import json, sys
p = sys.argv[1] + '/meta.json'; m = json.load(open(p)); m['t1'] = float(sys.argv[2]); m['wall_s'] = m['t1'] - m['t0']
m['t_orphans_done'] = float(sys.argv[3])
json.dump(m, open(p, 'w'), indent=1)
EOF
echo "done $RID"
