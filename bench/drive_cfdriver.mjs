// A/B 的 CFDriver 一方：连上独立实例（CFD_PORT），新建任务、开自动模式和 OpenFOAM 模式，发同一份任务描述，
// 把所有事件带墙钟时间戳写进 RUN/events.jsonl。智能体结束（agent_end）且 10 min 内没有再启动、也没有本方求解进程时退出。
// 服务重启后只重连、记录事件，不重发任务（恢复靠 CFDriver 自己）。
// 用法: CFD_PORT=5310 node drive_cfdriver.mjs RUN_DIR [maxHours=12]
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import WS from 'ws';

const [run, hours = '12'] = process.argv.slice(2);
const port = process.env.CFD_PORT || '5310';
const work = path.join(run, 'work');
const task = fs.readFileSync(path.join(run, 'task.md'), 'utf8');
const ev = fs.createWriteStream(path.join(run, 'events.jsonl'), { flags: 'a' });
const put = (e) => ev.write(JSON.stringify({ t: Date.now() / 1000, e }) + '\n');
let sent = false, lastEnd = 0, running = false, pendingUntil = 0, completed = false;

function solversHere() {
  try {
    // 只数求解器进程本身（argv0 以 Foam 结尾），不数 pgrep/bash/路径里含 Foam 的进程
    const out = execSync('for p in /proc/[0-9]*; do a=$(tr "\\0" "\\n" < $p/cmdline 2>/dev/null | head -1); case "${a##*/}" in *Foam) readlink $p/cwd;; esac; done', { shell: '/bin/bash' }).toString();
    return out.split('\n').filter(d => d.startsWith(work)).length;
  } catch { return 0; }
}

function connect() {
  const ws = new WS(`ws://127.0.0.1:${port}`);
  ws.on('open', () => {
    put({ type: 'ws_open' });
    if (sent) return;
    ws.send(JSON.stringify({ type: 'task_new', title: path.basename(run) }));
    ws.send(JSON.stringify({ type: 'set_foam', value: true }));
    ws.send(JSON.stringify({ type: 'set_auto', value: true }));
    ws.send(JSON.stringify({ type: 'user', text: task }));
    sent = true; put({ type: 'task_sent' });
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (['delta', 'assistant_delta', 'token', 'reasoning', 'pty_out', 'solver_log'].includes(m.type)) return;
    // 后台求解器日志逐行广播（[OF runId] …）只给界面看，不进模型上下文；不录，免得 events.jsonl 上百 MB
    if (m.type === 'term' && /^\[OF [0-9a-f]{8}\] /.test(m.line || '') && !/FATAL|NF_HEALTH|^\[OF [0-9a-f]{8}\] End$/.test(m.line)) return;
    if (m.type === 'agent_start') running = true;
    if (m.type === 'agent_end') { running = false; lastEnd = Date.now(); }
    // CFDriver 自动恢复已排期（"[LLM recovery] ... retry n/8 at ISO"）：排期时刻前不算结束
    if (m.type === 'term' && /\[LLM recovery\].*retry (\d+)\/(\d+) at (\S+?);/.test(m.line || '')) {
      const [, n, max, iso] = m.line.match(/retry (\d+)\/(\d+) at (\S+?);/);
      if (Number(n) < Number(max)) pendingUntil = Math.max(pendingUntil, Date.parse(iso) + 120e3);
    }
    if (m.type === 'tool_call' && m.name === 'task_complete') completed = true;
    put(m);
  });
  ws.on('close', () => { put({ type: 'ws_close' }); setTimeout(connect, 5000); });
  ws.on('error', (e) => put({ type: 'ws_error', message: e.message }));
}

connect();
const deadline = Date.now() + Number(hours) * 3600e3;
setInterval(() => {
  // 智能体 agent_end 后 3 min 内没有再启动（自动续跑会再 agent_start），且本方没有求解器在跑 → 视为它宣布完成
  const idle = lastEnd && !running && Date.now() - lastEnd > 180e3 && (completed || Date.now() > pendingUntil) && solversHere() === 0;
  if (idle || Date.now() > deadline) { put({ type: idle ? 'driver_done' : 'driver_timeout' }); ev.end(() => process.exit(0)); }
}, 30e3);
