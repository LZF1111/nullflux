// 接管手动启动的求解作业（Linux /proc 扫描）：用户在终端里直接 nohup mpirun ... 起的 OpenFOAM 求解器，
// 服务找到后登记到 SOLVER_RUNS（只读监视日志、结束时推送通知），不改动它的任何文件。
import fs from 'fs';
import path from 'path';

const SOLVER_RE = /(?:^|[\s/])([A-Za-z0-9]+Foam|foamRun|snappyHexMesh|lmp_\w+|liggghts\w*)(?=\s|$)/;
const NOT_SOLVER = new Set(['paraFoam']);
const LAUNCHERS = new Set(['mpirun', 'mpiexec', 'orterun', 'orted', 'prterun', 'prted', 'hydra_pmi_proxy']);

export function solverName(argv = []) {
  const m = argv.join(' ').match(SOLVER_RE);
  return m && !NOT_SOLVER.has(m[1]) ? m[1] : '';
}

function parseStat(text) {
  // pid (comm) state ppid pgrp ... 第 22 字段 starttime；comm 可含空格，从最后一个 ')' 后解析
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(rest[1]), pgid: Number(rest[2]), starttime: Number(rest[19]) };
}

export function readProcTable(procRoot = '/proc', fsImpl = fs) {
  const out = [];
  let names = [];
  try { names = fsImpl.readdirSync(procRoot); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const argv = fsImpl.readFileSync(path.posix.join(procRoot, n, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (!argv.length) continue;
      const st = parseStat(fsImpl.readFileSync(path.posix.join(procRoot, n, 'stat'), 'utf8'));
      out.push({ pid: Number(n), argv, ...st });
    } catch {}
  }
  return out;
}

// 只选每棵作业树的顶层：mpirun 本体或独立运行的求解器；MPI rank（父进程是 mpirun/另一个求解器）跳过；
// skipAncestors 里的 pid（服务自身、已登记作业）的后代也跳过
export function pickCandidates(table, skipAncestors = new Set()) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  const isCand = p => !!p && !!solverName(p.argv);
  const result = [];
  for (const p of table) {
    if (!isCand(p)) continue;
    const parent = byPid.get(p.ppid);
    if (isCand(parent) || (parent && LAUNCHERS.has(path.posix.basename(parent.argv[0] || '')))) continue;
    let a = p, hops = 0, skip = false;
    while (a && hops++ < 64) {
      if (skipAncestors.has(a.pid)) { skip = true; break; }
      a = byPid.get(a.ppid);
    }
    if (!skip) result.push({ ...p, solver: solverName(p.argv) });
  }
  return result;
}

// 日志：优先 stdout 重定向的文件（/proc/<pid>/fd/1），否则取 cwd 下最近 10 分钟内更新过的 log*
export function resolveLog(pid, cwd, { procRoot = '/proc', fsImpl = fs, now = Date.now() } = {}) {
  try {
    const t = fsImpl.readlinkSync(path.posix.join(procRoot, String(pid), 'fd', '1'));
    if (t.startsWith('/') && !t.startsWith('/dev/') && !t.endsWith('(deleted)') && fsImpl.statSync(t).isFile()) return t;
  } catch {}
  if (!cwd) return null;
  try {
    const logs = fsImpl.readdirSync(cwd).filter(f => /^log/.test(f))
      .map(f => { const full = path.posix.join(cwd, f); try { const s = fsImpl.statSync(full); return s.isFile() ? { full, m: s.mtimeMs } : null; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.m - a.m);
    if (logs[0] && now - logs[0].m < 10 * 60_000) return logs[0].full;
  } catch {}
  return null;
}

// 进程启动时刻（ms）：btime + starttime / CLK_TCK（Linux 上 CLK_TCK 基本都是 100）
export function processStartMs(starttime, { procRoot = '/proc', fsImpl = fs, clkTck = 100 } = {}) {
  try {
    const m = fsImpl.readFileSync(path.posix.join(procRoot, 'stat'), 'utf8').match(/^btime\s+(\d+)/m);
    if (m && Number.isFinite(starttime)) return (Number(m[1]) + starttime / clkTck) * 1000;
  } catch {}
  return null;
}

// 没有退出码时按日志尾判断：FATAL / 崩溃 → 1，正常 End → 0，看不出来 → null
export function inferExitFromLog(lines = []) {
  const tail = lines.slice(-300);
  // 最后一个 "Time =" 之后出现 End：计算已完成，其后的 abort/MPI 收尾（如 v2306 twoPhaseEulerFoam exit 134）不算失败
  let sawEnd = false;
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = String(tail[i]).replace(/^\[\d+\]\s*/, '').trim();
    if (l === 'End') sawEnd = true;
    else if (/^Time\s*=/.test(l)) { if (sawEnd) return 0; break; }
    else if (!sawEnd && /FOAM FATAL/.test(l)) break;
  }
  if (tail.some(l => /FOAM FATAL|FOAM aborting|Segmentation fault|signal 11|MPI_ABORT|mpirun noticed that process|exited on signal|^ERROR( on proc \d+)?:/i.test(l))) return 1;
  if (tail.some(l => l.trim() === 'End')) return 0;
  // LIGGGHTS / LAMMPS：最后一个 run 的 "Loop time of" 之后没有 ERROR 即正常完成
  if (tail.some(l => /^Loop time of /.test(l)) && /^Total wall time:/m.test(tail.slice(-20).join('\n'))) return 0;
  return null;
}

// 作业进程树（rootPid 的后代）里求解器或它的 mpirun 的 stdout 指向的普通文件：
// 作业脚本内部自己重定向（./Allrun 里 mpirun … > log.xxx）时，用它当求解日志。广度优先，先找到最上层的 mpirun。
export function findTreeLog(rootPid, table, skip = '', { procRoot = '/proc', fsImpl = fs } = Object.create(null)) {
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const queue = [...(kids.get(rootPid) || [])];
  let hops = 0;
  while (queue.length && hops++ < 4096) {
    const p = queue.shift();
    if (solverName(p.argv)) {
      try {
        const t = fsImpl.readlinkSync(path.posix.join(procRoot, String(p.pid), 'fd', '1'));
        if (t.startsWith('/') && !t.startsWith('/dev/') && !t.endsWith('(deleted)') && t !== skip && fsImpl.statSync(t).isFile()) return t;
      } catch (e) { /* 进程刚退出或无权限：看下一个 */ }
    }
    queue.push(...(kids.get(p.pid) || []));
  }
  return '';
}
