// OpenFOAM postProcessing/<functionObject>/<startTime>/*.dat parsing + windowed statistics.
import fs from 'fs/promises';
import path from 'path';

// Split a data line into top-level tokens; "(a b (c d))" becomes one flattened numeric group.
export function tokenizeDatLine(line) {
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) break; }
      }
      const inner = s.slice(i + 1, j).replace(/[()]/g, ' ').trim();
      out.push(inner ? inner.split(/\s+/).map(Number) : []);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '(') j++;
    out.push(Number(s.slice(i, j)));
    i = j;
  }
  return out;
}

// Streaming divergence detector over solver log lines; state h persists across calls. Returns reason or ''.
export function detectDivergence(h, lines, { warmup = 200, ratio = 1e-4, floor = 1e-15, streak = 30 } = {}) {
  if (h.n == null) Object.assign(h, { n: 0, ref: 0, low: 0, t: '' });
  for (const l of lines) {
    if (l.startsWith('Time = ')) { h.t = l.slice(7).trim(); continue; }
    if (/Initial residual = (-?nan|inf)\b/i.test(l)) return `残差出现 NaN/Inf：${l.trim().slice(0, 120)}`;
    const m = /^deltaT = ([-+\d.eE]+)/.exec(l);
    if (!m) continue;
    const dt = Number(m[1]);
    if (!(dt > 0)) continue;
    h.n++;
    if (h.n <= warmup) { h.ref = Math.max(h.ref, dt); continue; }
    h.ref = Math.max(h.ref * 0.9999, dt);
    if (dt < floor || dt < h.ref * ratio) {
      if (++h.low >= streak) return `时间步崩塌：deltaT=${dt.toExponential(2)}（稳定值约 ${h.ref.toExponential(2)}），已连续 ${h.low} 步 → 局部速度发散`;
    } else h.low = 0;
  }
  return '';
}

function headerNames(h) {
  const body = h.replace(/^#\s*/, '');
  const parts = body.includes('\t') ? body.split(/\t+/) : body.split(/\s+/);
  return parts.map(x => x.trim()).filter(Boolean);
}

export function parseFoamDat(text) {
  let header = null;
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      const names = headerNames(l);
      if (names.length && /^time$/i.test(names[0])) header = names;
      continue;
    }
    const toks = tokenizeDatLine(l);
    if (!toks.length || typeof toks[0] !== 'number' || !Number.isFinite(toks[0])) continue;
    rows.push(toks);
  }
  if (!rows.length) return { columns: [], time: [], data: {} };
  const proto = rows[0];
  const useHeader = header && header.length === proto.length;
  const columns = [];
  const slots = [];
  for (let k = 1; k < proto.length; k++) {
    const base = useHeader ? header[k] : `col${k}`;
    const tok = proto[k];
    if (Array.isArray(tok)) {
      const sfx = tok.length === 3 ? ['x', 'y', 'z'] : tok.map((_, q) => String(q));
      tok.forEach((_, q) => { columns.push(`${base}_${sfx[q]}`); slots.push([k, q]); });
    } else { columns.push(base); slots.push([k, -1]); }
  }
  const time = [];
  const data = Object.fromEntries(columns.map(c => [c, []]));
  for (const r of rows) {
    if (r.length !== proto.length) continue;
    time.push(r[0]);
    slots.forEach(([k, q], ci) => {
      const v = q < 0 ? r[k] : (Array.isArray(r[k]) ? r[k][q] : NaN);
      data[columns[ci]].push(Number.isFinite(v) ? v : NaN);
    });
  }
  return { columns, time, data };
}

// Merge restart segments: a later segment supersedes earlier rows from its first time onward.
export function mergeSeries(segments) {
  const segs = segments.filter(s => s && s.time.length).sort((a, b) => a.time[0] - b.time[0]);
  if (!segs.length) return { columns: [], time: [], data: {} };
  const columns = segs[segs.length - 1].columns;
  const time = [];
  const data = Object.fromEntries(columns.map(c => [c, []]));
  segs.forEach((s, si) => {
    const cut = si + 1 < segs.length ? segs[si + 1].time[0] : Infinity;
    for (let i = 0; i < s.time.length; i++) {
      if (s.time[i] >= cut) break;
      time.push(s.time[i]);
      for (const c of columns) data[c].push(s.data[c] ? s.data[c][i] : NaN);
    }
  });
  return { columns, time, data };
}

// Batch-means standard error: robust to the strong autocorrelation of fluidized-bed signals.
export function batchMeansSem(xs, nBatches = 10) {
  const n = xs.length;
  if (n < 2 * nBatches) {
    if (n < 2) return NaN;
    const m = xs.reduce((a, b) => a + b, 0) / n;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
    return Math.sqrt(v / n);
  }
  const size = Math.floor(n / nBatches);
  const means = [];
  for (let b = 0; b < nBatches; b++) {
    const seg = xs.slice(b * size, (b + 1) * size);
    means.push(seg.reduce((a, c) => a + c, 0) / seg.length);
  }
  const m = means.reduce((a, b) => a + b, 0) / nBatches;
  const v = means.reduce((a, b) => a + (b - m) ** 2, 0) / (nBatches - 1);
  return Math.sqrt(v / nBatches);
}

export function windowStats(series, { tStart = null, tEnd = null, lastFraction = null, columns = null, driftTol = 0.05 } = {}) {
  const t = series.time;
  if (!t.length) return { n: 0, window: null, stats: {} };
  let lo = tStart != null ? tStart : -Infinity;
  const hi = tEnd != null ? tEnd : Infinity;
  if (tStart == null && lastFraction != null && lastFraction > 0 && lastFraction <= 1) {
    const t0 = t[0], t1 = t[t.length - 1];
    lo = t1 - (t1 - t0) * lastFraction;
  }
  const idx = [];
  for (let i = 0; i < t.length; i++) if (t[i] >= lo && t[i] <= hi) idx.push(i);
  const cols = (columns && columns.length ? columns : series.columns).filter(c => series.data[c]);
  const stats = {};
  for (const c of cols) {
    const xs = idx.map(i => series.data[c][i]).filter(Number.isFinite);
    if (!xs.length) { stats[c] = { n: 0 }; continue; }
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const std = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    const h = Math.floor(n / 2);
    const m1 = h ? xs.slice(0, h).reduce((a, b) => a + b, 0) / h : mean;
    const m2 = n - h ? xs.slice(h).reduce((a, b) => a + b, 0) / (n - h) : mean;
    const drift = Math.abs(m2 - m1) / Math.max(Math.abs(mean), std, 1e-12);
    let lo = Infinity, hi = -Infinity;
    for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
    stats[c] = {
      n, mean, std, sem: batchMeansSem(xs), min: lo, max: hi, last: xs[n - 1],
      half_means: [m1, m2], rel_drift: drift, stationary: n >= 20 && drift < driftTol,
    };
  }
  return { n: idx.length, window: idx.length ? [t[idx[0]], t[idx[idx.length - 1]]] : null, stats };
}

export async function listFunctionObjects(casePath) {
  const root = path.join(casePath, 'postProcessing');
  let dirs = [];
  try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const files = new Set();
    let times = [];
    try { times = (await fs.readdir(path.join(root, d.name), { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name); } catch {}
    for (const tdir of times) {
      try { for (const f of await fs.readdir(path.join(root, d.name, tdir))) if (/\.(dat|xy|csv)$/i.test(f)) files.add(f); } catch {}
    }
    out.push({ name: d.name, start_times: times.sort((a, b) => Number(a) - Number(b)), files: [...files].sort() });
  }
  return out;
}

export async function loadFunctionObject(casePath, fo, file = null) {
  const foDir = path.join(casePath, 'postProcessing', fo);
  const times = (await fs.readdir(foDir, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
  if (!times.length) throw new Error(`postProcessing/${fo} 下没有时间目录`);
  const segments = [];
  let chosen = file;
  for (const tdir of times) {
    const files = (await fs.readdir(path.join(foDir, tdir))).filter(f => /\.(dat|xy)$/i.test(f));
    if (!chosen) chosen = files.length === 1 ? files[0] : null;
    if (!chosen) throw new Error(`postProcessing/${fo}/${tdir} 下有多个文件，请指定 file: ${files.join(', ')}`);
    if (!files.includes(chosen)) continue;
    segments.push(parseFoamDat(await fs.readFile(path.join(foDir, tdir, chosen), 'utf8')));
  }
  return { file: chosen, series: mergeSeries(segments) };
}
