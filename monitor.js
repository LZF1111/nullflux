// 实时监视页（/monitor）的数据层：从求解日志尾部读 Time，按墙钟采样算推进速率与 ETA；读 RSI 档案。
// 只读，不改任何算例。
import fssync from 'fs';
import path from 'path';

const TIME_RE = /^Time\s*=\s*([\d.eE+\-]+)/gm;

export function tailText(file, bytes = 1 << 20) {
  let fd;
  try {
    fd = fssync.openSync(file, 'r');
    const size = fssync.fstatSync(fd).size, len = Math.min(size, bytes);
    const buf = Buffer.alloc(len); fssync.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), size, mtime: fssync.fstatSync(fd).mtimeMs };
  } catch { return null; } finally { if (fd !== undefined) try { fssync.closeSync(fd); } catch {} }
}

export function lastTime(text) {
  const ms = text ? [...text.matchAll(TIME_RE)] : [];
  return ms.length ? Number(ms[ms.length - 1][1]) : null;
}

// 直接从日志尾部算速率：每步 Time 之后的 ClockTime 成对取首尾 → 物理秒 / 墙钟小时（页面一打开就有，不等采样）
export function rateFromLog(text) {
  if (!text) return null;
  const pts = []; let t = null;
  for (const m of text.matchAll(/^Time\s*=\s*([\d.eE+\-]+)|ClockTime\s*=\s*([\d.eE+\-]+)/gm)) {
    if (m[1] !== undefined) t = Number(m[1]);
    else if (t !== null) { pts.push([t, Number(m[2])]); t = null; }
  }
  if (pts.length < 2) return null;
  const [t0, c0] = pts[0], [t1, c1] = pts[pts.length - 1];
  return c1 - c0 >= 30 ? (t1 - t0) / ((c1 - c0) / 3600) : null;
}

// 最近一步的 Courant 与 deltaT（多相求解器日志里的常见格式）
export function lastStepInfo(text) {
  if (!text) return {};
  const co = [...text.matchAll(/Courant Number mean:\s*([\d.eE+\-]+)\s*max:\s*([\d.eE+\-]+)/g)].pop();
  const dt = [...text.matchAll(/^deltaT\s*=\s*([\d.eE+\-]+)/gm)].pop();
  const fatal = /FOAM FATAL|Floating point exception|nan\b/i.test(text.slice(-20000));
  return { coMax: co ? Number(co[2]) : null, deltaT: dt ? Number(dt[1]) : null, fatal };
}

// 日志开头第一步的 Time：startFrom latestTime 时 controlDict 的 startTime 不是本次起点
const FIRST_TIME = new Map();
export function firstTime(file, budget = 16 << 20) {
  let fd;
  try {
    fd = fssync.openSync(file, 'r');
    const st = fssync.fstatSync(fd);
    let c = FIRST_TIME.get(file);
    if (!c || c.ino !== st.ino || st.size < c.size) c = { ino: st.ino, size: 0, pos: 0, t: null };
    c.size = st.size;
    FIRST_TIME.set(file, c);
    if (c.t !== null) return c.t;
    const buf = Buffer.alloc(1 << 20);
    let pos = Math.max(0, c.pos - 256), read = 0;
    while (pos < st.size && read < budget) {
      const n = fssync.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      let text = buf.subarray(0, n).toString('latin1');
      if (pos > 0) text = text.slice(text.indexOf('\n') + 1);
      const m = text.match(pos + n >= st.size ? /^Time\s*=\s*([\d.eE+\-]+)/m : /^Time\s*=\s*([\d.eE+\-]+)[ \t]*\r?\n/m);
      if (m) { c.t = Number(m[1]); return c.t; }
      pos += n > 256 ? n - 256 : n; read += n; c.pos = pos;
    }
    return null;
  } catch (e) { return null; } finally { if (fd !== undefined) try { fssync.closeSync(fd); } catch (e) { /* 已关闭 */ } }
}

export function readEndTime(caseDir) {
  try {
    const t = fssync.readFileSync(path.join(caseDir, 'system', 'controlDict'), 'utf8');
    const s = t.match(/^startTime\s+([\d.eE+\-]+)\s*;/m), e = t.match(/^endTime\s+([\d.eE+\-]+)\s*;/m);
    return { start: s ? Number(s[1]) : null, end: e ? Number(e[1]) : null };
  } catch { return { start: null, end: null }; }
}

// 每个日志一条采样序列；速率取最近 window 毫秒内首尾两点（至少 2 个点、间隔 ≥60 s）
export class RateTracker {
  constructor({ windowMs = 30 * 60_000, maxSamples = 400 } = {}) { this.windowMs = windowMs; this.maxSamples = maxSamples; this.s = new Map(); }
  add(key, simTime, wall = Date.now()) {
    if (!Number.isFinite(simTime)) return;
    const a = this.s.get(key) || [];
    if (a.length && a[a.length - 1].t === simTime) { this.s.set(key, a); return; }
    if (a.length && simTime < a[a.length - 1].t) a.length = 0;          // 重启或换时间轴：重新计
    a.push({ t: simTime, w: wall });
    while (a.length > this.maxSamples || (a.length > 2 && wall - a[0].w > this.windowMs)) a.shift();
    this.s.set(key, a);
  }
  rate(key) {                                                         // 物理秒 / 墙钟小时
    const a = this.s.get(key) || [];
    if (a.length < 2) return null;
    const dw = (a[a.length - 1].w - a[0].w) / 3.6e6;
    return dw >= 60 / 3600 ? (a[a.length - 1].t - a[0].t) / dw : null;
  }
  history(key) { return (this.s.get(key) || []).map(p => [p.w, p.t]); }
}

export function progress({ start, end, now, rate }) {
  if (!Number.isFinite(end) || !Number.isFinite(now)) return { frac: null, etaH: null };
  const s = Number.isFinite(start) && start < end ? start : null;
  const frac = s === null ? null : Math.min(1, Math.max(0, (now - s) / (end - s)));
  const etaH = rate && rate > 0 ? Math.max(0, (end - now) / rate) : null;
  return { frac, etaH };
}

export function headText(file, bytes = 64 << 10) {
  let fd;
  try {
    fd = fssync.openSync(file, 'r');
    const buf = Buffer.alloc(bytes), n = fssync.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fssync.closeSync(fd); } catch {} }
}

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

export function readMaxCo(caseDir) {
  const t = headText(path.join(caseDir, 'system', 'controlDict'));
  const m = t && t.match(/^maxCo\s+([\d.eE+\-]+)\s*;/m);
  return m ? num(m[1]) : null;
}

// 求解告警：FATAL/NaN、Courant 超限、日志停更。返回 [{kind, level, text, hint}]
export function jobAlerts(job, { maxCo = null, staleS = 300 } = {}) {
  const out = [];
  if (!job) return out;
  if (job.fatal) out.push({ kind: 'fatal', level: 'error', text: '日志出现 FATAL / NaN / 浮点异常',
    hint: '看日志尾部定位出错的方程和时间步；常见原因是 Δt 过大、边界条件不一致或物性越界。' });
  const lim = Number.isFinite(maxCo) && maxCo > 0 ? Math.max(1, 2 * maxCo) : 1;
  if (Number.isFinite(job.coMax) && job.coMax > lim) out.push({ kind: 'courant', level: 'warn', text: `Courant 数 ${job.coMax.toFixed(2)} 超过 ${lim}`,
    hint: '减小 maxCo / maxDeltaT，或检查局部速度异常的网格单元。' });
  if (Number.isFinite(job.logAgeS) && job.logAgeS > staleS && !(job.frac >= 1)) out.push({ kind: 'stale', level: 'warn',
    text: `日志 ${Math.round(job.logAgeS / 60)} 分钟没有更新`, hint: '进程可能卡在 I/O 或 MPI 等待，也可能已退出；先确认进程和磁盘空间。' });
  return out;
}

// 同一告警在 windowMs 内只发一次
export class AlertGate {
  constructor(windowMs = 30 * 60_000) { this.windowMs = windowMs; this.last = new Map(); }
  should(key, now = Date.now()) {
    const t = this.last.get(key);
    if (t !== undefined && now - t < this.windowMs) return false;
    this.last.set(key, now); return true;
  }
}

// OpenFOAM boundary 文件 → [{name, type}]
export function parseBoundary(text) {
  if (!text) return [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hdr = body.indexOf('FoamFile');
  const from = hdr >= 0 ? body.indexOf('}', hdr) + 1 : 0;
  const s = body.slice(Math.max(0, body.indexOf('(', from)));
  const out = []; const re = /([A-Za-z_][\w.:-]*)\s*\{([^{}]*)\}/g; let m;
  while ((m = re.exec(s))) { const t = m[2].match(/\btype\s+(\w+)\s*;/); out.push({ name: m[1], type: t ? t[1] : '' }); }
  return out;
}

// 算例总览：求解器、网格规模、边界区、时刻、结果文件。只读
export function caseOverview(dir) {
  const cd = headText(path.join(dir, 'system', 'controlDict')) || '';
  const g = re => { const m = cd.match(re); return m ? m[1] : null; };
  let ents = []; try { ents = fssync.readdirSync(dir, { withFileTypes: true }); } catch {}
  const procs = ents.filter(e => e.isDirectory() && /^processor\d+$/.test(e.name)).map(e => e.name);
  const timesIn = d => { try { return fssync.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && /^[\d.eE+\-]+$/.test(e.name)).map(e => Number(e.name)).filter(Number.isFinite); } catch { return []; } };
  const times = [...timesIn(dir), ...(procs.length ? timesIn(path.join(dir, procs[0])) : [])].filter(t => t > 0);
  const rootMesh = path.join(dir, 'constant', 'polyMesh');
  const meshDirs = fssync.existsSync(path.join(rootMesh, 'owner')) ? [rootMesh] : procs.map(p => path.join(dir, p, 'constant', 'polyMesh'));
  let nCells = 0, haveCells = false;
  for (const m of meshDirs) {
    const c = (headText(path.join(m, 'owner'), 4096) || '').match(/nCells:\s*(\d+)/);
    if (c) { nCells += Number(c[1]); haveCells = true; }
  }
  const patches = meshDirs.length ? parseBoundary(headText(path.join(meshDirs[0], 'boundary'), 256 << 10)).filter(p => !/^processor/.test(p.type)) : [];
  return {
    application: g(/^application\s+([\w.-]+)\s*;/m), endTime: num(g(/^endTime\s+([\d.eE+\-]+)\s*;/m)), maxCo: num(g(/^maxCo\s+([\d.eE+\-]+)\s*;/m)),
    nProcs: procs.length, latestTime: times.length ? Math.max(...times) : null, nTimes: new Set(times).size,
    nCells: haveCells ? nCells : null, nPatches: patches.length, patches: patches.slice(0, 40),
    results: ents.filter(e => e.isFile() && /\.json$/i.test(e.name)).map(e => e.name).sort().slice(0, 24),
  };
}

// RSI 分布器档案：试验状态、冠军、对照，以及运行中试验的求解日志
export function rsiSnapshot(root) {
  if (!root || !fssync.existsSync(path.join(root, 'archive.json'))) return null;
  let a; try { a = JSON.parse(fssync.readFileSync(path.join(root, 'archive.json'), 'utf8')); } catch { return null; }
  const trials = Object.values(a.trials || {}).map(t => {
    const mv = t.metrics_visible || {};
    const dir = path.join(root, 'trials', t.hash);
    const stages = ['generate', 'mesh', 'solve', 'verify'].filter(s => fssync.existsSync(path.join(dir, 'logs', `${s}.stdout.log`)));
    return { hash: t.hash, cell: t.cell, state: t.state, control: !!t.control, n_holes: t.features?.n_holes, d_eq_mm: t.features?.d_eq_mm,
      r_mean_over_R: t.features?.r_mean_over_R, surrogate: t.surrogate, loss: mv.loss_fig12b ?? null, min006: mv.min_over_wall_006 ?? null,
      min010: mv.min_over_wall_010 ?? null, kpi_dev: mv.kpi_dev_max_pct ?? null, stage: stages[stages.length - 1] || null,
      solveLog: t.state === 'running' ? path.join(dir, 'logs', 'solve.stdout.log') : null, caseDir: dir, started: t.started, ended: t.ended };
  }).sort((x, y) => (x.started || 0) - (y.started || 0));
  let rounds = [];
  const cl = tailText(path.join(root, 'campaign.log'), 64 << 10);
  if (cl) rounds = cl.text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-20);
  const chain = tailText(path.join(root, 'chain.out'), 8 << 10);
  return { champion: a.champion, control: a.control ? { hash: a.control.hash, state: a.control.state, diff: a.control.control_diff ?? null } : null,
    cells: a.cells || {}, surrogate: a.surrogate || {}, trials, rounds, chainTail: chain ? chain.text.split('\n').slice(-8).join('\n') : '' };
}
