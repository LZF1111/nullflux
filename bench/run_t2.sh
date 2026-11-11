#!/bin/bash
# T2 一方：长作业 + 固定时刻故障（见 T2_PROTOCOL.md，开跑前写定）。用法: run_t2.sh {cfdriver|opencode} RUN_ID
SIDE=$1; RID=$2
B=$HOME/bench; R=$B/runs/$RID; W=$R/work
mkdir -p "$W"; cp "$B/tasks/${T2_TASK:-T2}.md" "$R/task.md"   # T2_TASK 只给冒烟测试换短任务
# LLM_PORT / CFD_COPY / CFD_PORT / OC_PORT 可覆盖，用于同时跑多对（每对端口不同）
PORT=${LLM_PORT:-$([ "$SIDE" = cfdriver ] && echo 18091 || echo 18092)}; CTRL=$R/llm.ctrl; echo up > $CTRL
python3 $B/port_relay.py $PORT $CTRL > "$R/relay.log" 2>&1 & RELAY=$!
T0=$(date +%s.%N)
echo "{\"side\":\"$SIDE\",\"task\":\"T2\",\"run\":\"$RID\",\"t0\":$T0,\"model\":\"claude-opus-5-5\",\"cores_cap\":8,\"llm_port\":$PORT}" > "$R/meta.json"
fault() { echo "{\"t\":$(date +%s.%N),\"fault\":\"$1\"}" >> "$R/faults.jsonl"; }
# 只数求解器本身（argv0 以 Foam 结尾）；pgrep -f Foam 会误中命令行里带任务文本 "OpenFOAM" 的 opencode 进程
nsolv() { n=0; for p in /proc/[0-9]*; do a=$(tr '\0' '\n' < $p/cmdline 2>/dev/null | head -1); case "${a##*/}" in *Foam) case "$(readlink $p/cwd 2>/dev/null)" in "$W"*) n=$((n+1));; esac;; esac; done; echo $n; }
( while :; do
    L=$(find "$W" -name 'log*' -newermt '-2 min' -type f 2>/dev/null | head -1); tm=""
    [ -n "$L" ] && tm=$(tail -c 20000 "$L" | grep -a '^Time = ' | tail -1 | cut -c8-)
    echo "{\"t\":$(date +%s.%N),\"procs\":$(nsolv),\"time\":\"$tm\",\"llm\":\"$(cat $CTRL)\"}" >> "$R/samples.jsonl"; sleep 30
  done ) & SAMP=$!
source /home/user/OpenFOAM/OpenFOAM-v2306/etc/bashrc >/dev/null 2>&1 || true
. $B/nsbox.sh; nsbox_create "$RID" || exit 1
cd "$W"
# T2 专用：CFDriver 副本 ~/bench/cfdriver_t2（端口 5311），OpenCode 私有服务（--standalone）+ 本次独立数据目录；
# 与同时在跑的 T1 完全隔离，重启只影响本方
C=$B/${CFD_COPY:-cfdriver_t2}; CPORT=${CFD_PORT:-5311}; OCPORT=${OC_PORT:-49480}
[ -f $C/server.js ] || { mkdir -p $C/tasks; tar -C $B/cfdriver --exclude=./tasks --exclude=./runs.json -cf - . | tar -xf - -C $C; }
[ -f $C/server.js ] || { echo "cfdriver copy failed"; exit 1; }
python3 -c "import json;m=json.load(open('$R/meta.json'));m['cfdriver_copy']='$C';m['cfdriver_sha']='$(sha1sum $C/server.js | cut -c1-12)';json.dump(m,open('$R/meta.json','w'))"
# 登记占核，RSI 调度器不会抢这 8 核
( cd $HOME/nullflux-test/rsi && python3 -m core.claims /home/user/mto_repro/rsi_claims.json add "bench:$RID" 8 external 21600 )
agent_pids() {   # 只找智能体宿主进程本身，不含它启动的求解器
  if [ "$SIDE" = opencode ]; then
    for p in $(pgrep -f "$HOME/bench/opencode/opencode"); do tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -qx "XDG_DATA_HOME=$R/oc_data" && echo $p; done
  else
    for p in $(pgrep -f "server.js --host 127.0.0.1 --port $CPORT"); do basename "$(readlink /proc/$p/exe 2>/dev/null)" | grep -qx node && echo $p; done
  fi
}
start_agent() {   # $1 = first|restart
  if [ "$SIDE" = opencode ]; then
    . $B/oc_env.sh; export XDG_CONFIG_HOME=$R/oc_config XDG_DATA_HOME=$R/oc_data XDG_STATE_HOME=$R/oc_state
    # 首次任务从 stdin 给（命令行参数里带任务文本会被 pkill -f pimpleFoam 误中）；重启续接只发"继续"
    if [ "$1" = first ]; then IN="$R/task.md"; EXTRA=""; MSG=""; else IN=/dev/null; MSG="继续"; EXTRA="--continue"; fi
    # 本方独立后台服务端口：避免与 T1 用的默认服务（49374）冲突；重启时这个服务也被杀，--continue 时由 run 重新拉起
    # 智能体（及其后台服务和它启动的求解器）跑在本方 PID 命名空间里：它的 pkill 碰不到同机的其他运行
    ( cd "$W" && nsbox_run "$RID" bash -c 'opencode service set port '$OCPORT' >/dev/null 2>&1; exec opencode run "$@"' _ $EXTRA --auto --format json --title "$RID" -m relay/claude-opus-5-5 $MSG < "$IN" 2>> "$R/stderr.log" \
      | while IFS= read -r line; do printf '{"t":%s,"e":%s}\n' "$(date +%s.%N)" "$line"; done >> "$R/events.jsonl" ) &
    AG=$!
  else
    ( cd "$C" && nsbox_run "$RID" node server.js --host 127.0.0.1 --port $CPORT >> "$R/cfdriver_server.log" 2>&1 ) &
    for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$CPORT/ && break; sleep 2; done
    if [ "$1" = first ]; then
      cp $B/drive_cfdriver.mjs $C/test/bench_drive.mjs
      # 驱动只在第一次发任务；服务重启后它只重连、记录，不重发
      (cd $C && CFD_PORT=$CPORT node test/bench_drive.mjs "$R" 6 2>> "$R/stderr.log") & AG=$!
    fi
  fi
}
kill_agent() {   # 模拟宿主崩溃：SIGKILL 智能体进程本身；它启动的求解器怎样由各自的设计决定
  P=$(agent_pids | tr '\n' ' '); echo "{\"t\":$(date +%s.%N),\"killed\":\"$P\",\"solvers_before\":$(nsolv)}" >> "$R/faults.jsonl"
  [ -n "$P" ] && kill -9 $P 2>/dev/null; sleep 5
  echo "{\"t\":$(date +%s.%N),\"solvers_after_kill\":$(nsolv)}" >> "$R/faults.jsonl"
}
if [ "$SIDE" = opencode ]; then
  # 本方模型端点改到专用可断端口：本次运行单独一份配置，不影响同时在跑的 T1
  mkdir -p "$R/oc_config/opencode"; cp -r $B/oc_home/data "$R/oc_data"; mkdir -p "$R/oc_state"
  sed "s#127.0.0.1:18081/v1#127.0.0.1:$PORT/v1#" $B/oc_home/config/opencode/opencode.json > "$R/oc_config/opencode/opencode.json"
  grep -q ":$PORT/v1" "$R/oc_config/opencode/opencode.json" || { echo "oc config port not set"; exit 1; }
else
  python3 - "$C/settings.json" "$W" "$PORT" <<'EOF'
import json, sys
p, w, port = sys.argv[1], sys.argv[2], sys.argv[3]; s = json.load(open(p))
s.update(workspace=w, projects=[dict(path=w, name='bench')], adoptExternalRuns=False, foamMode=True, baseUrl=f'http://127.0.0.1:{port}')
json.dump(s, open(p, 'w'), indent=2)
EOF
  rm -f "$C/runs.json" "$C/tasks/"*.json 2>/dev/null
fi
start_agent first
sleep 20; agent_pids > "$R/agent_pids_first.txt"
DEAD=$(( $(date +%s) + 6*3600 ))
# 故障计时起点：第一次看到本方求解器进程
while [ "$(nsolv)" = 0 ] && kill -0 $AG 2>/dev/null && [ $(date +%s) -lt $DEAD ]; do sleep 15; done
TS=$(date +%s); fault solver_seen
# 协议时刻（秒）；T2_SCALE 只给冒烟测试缩短用，正式运行不设
S=${T2_SCALE:-1}; A1=$((600/S)); A2=$((900/S)); A3=$((1500/S)); A4=$((2400/S)); A5=$((2700/S))
STEP=0
# OpenCode 的 run 进程在任务结束时自行退出；CFDriver 的驱动在 agent_end + 10 min 空闲且无求解进程时退出。
# 重启后 OpenCode 的新 run 进程替代旧的，所以用"本方是否还有智能体进程"判断，而不只看 $AG
alive() { kill -0 $AG 2>/dev/null; }   # OpenCode 重启后 $AG 指向新的 run；CFDriver 的驱动跨服务重启一直在
while alive && [ $(date +%s) -lt $DEAD ]; do
  E=$(( $(date +%s) - TS ))
  if [ $STEP = 0 ] && [ $E -ge $A1 ]; then echo down > $CTRL; fault llm_down_1; STEP=1; fi
  if [ $STEP = 1 ] && [ $E -ge $A2 ]; then echo up > $CTRL;   fault llm_up_1;   STEP=2; fi
  if [ $STEP = 2 ] && [ $E -ge $A3 ]; then fault agent_kill; kill_agent; start_agent restart; fault agent_restarted; STEP=3; fi
  if [ $STEP = 3 ] && [ $E -ge $A4 ]; then echo down > $CTRL; fault llm_down_2; STEP=4; fi
  if [ $STEP = 4 ] && [ $E -ge $A5 ]; then echo up > $CTRL;   fault llm_up_2;   STEP=5; fi
  sleep 10
done
# 没走完的故障步骤要补上"恢复"，避免另一方任务结束后通路仍断着
echo up > $CTRL
T1=$(date +%s.%N); fault agent_finished
python3 $B/judge_t2.py "$W" > "$R/judge.out" 2>&1; cp "$W/judge.json" "$R/judge.json" 2>/dev/null
kill $SAMP $RELAY 2>/dev/null; [ "$SIDE" = cfdriver ] && { P=$(agent_pids); [ -n "$P" ] && kill $P; }
( cd $HOME/nullflux-test/rsi && python3 -m core.claims /home/user/mto_repro/rsi_claims.json remove "bench:$RID" )
nsbox_destroy "$RID"   # 收掉本方盒子里剩下的一切（后台服务等）
[ "$SIDE" = opencode ] && { . $B/oc_env.sh; export XDG_CONFIG_HOME=$R/oc_config XDG_DATA_HOME=$R/oc_data XDG_STATE_HOME=$R/oc_state; SID=$(grep -o '"sessionID":"[^"]*"' "$R/events.jsonl" | head -1 | cut -d'"' -f4); [ -n "$SID" ] && opencode session export "$SID" > "$R/session_export.json" 2>>"$R/stderr.log"; }
python3 - "$R" "$T1" "$STEP" <<'EOF'
import json, sys
p = sys.argv[1] + '/meta.json'; m = json.load(open(p)); m['t1'] = float(sys.argv[2]); m['wall_s'] = m['t1'] - m['t0']; m['fault_steps_done'] = int(sys.argv[3])
json.dump(m, open(p, 'w'), indent=1)
EOF
echo "done $RID"
