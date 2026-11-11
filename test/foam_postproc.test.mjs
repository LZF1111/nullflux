// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as FP from '../foam_postproc.js';

test('tokenize scalars and vectors', () => {
  assert.deepEqual(FP.tokenizeDatLine('0.5 1e-3 (1 2 3)'), [0.5, 0.001, [1, 2, 3]]);
  assert.deepEqual(FP.tokenizeDatLine('1 ((1 2 3) (4 5 6))'), [1, [1, 2, 3, 4, 5, 6]]);
});

test('parse header + vector expansion', () => {
  const s = FP.parseFoamDat('# Time\tareaAverage(p)\tU\n0.1 10 (1 0 0)\n0.2 11 (2 0 0)\n');
  assert.deepEqual(s.columns, ['areaAverage(p)', 'U_x', 'U_y', 'U_z']);
  assert.deepEqual(s.time, [0.1, 0.2]);
  assert.deepEqual(s.data.U_x, [1, 2]);
});

test('detectDivergence: dt collapse and NaN; healthy run stays quiet', () => {
  const healthy = [];
  for (let i = 0; i < 2000; i++) healthy.push(`Time = ${i * 1e-4}`, `deltaT = ${1.8e-4 * (0.7 + 0.3 * Math.sin(i))}`);
  assert.equal(FP.detectDivergence({}, healthy), '');
  const h = {};
  const warm = [];
  for (let i = 0; i < 300; i++) warm.push(`deltaT = 1.8e-4`);
  assert.equal(FP.detectDivergence(h, warm), '');
  const crash = [];
  for (let k = 1; k <= 40; k++) crash.push('Time = 0.175694', `deltaT = ${Math.pow(10, -4 - k * 3)}`);
  assert.match(FP.detectDivergence(h, crash), /时间步崩塌/);
  assert.equal(h.t, '0.175694');
  assert.match(FP.detectDivergence({}, ['smoothSolver:  Solving for Ux, Initial residual = nan, Final residual = nan']), /NaN/);
});

test('header mismatch falls back to colN', () => {
  const s = FP.parseFoamDat('# Time a\n1 2 3\n');
  assert.deepEqual(s.columns, ['col1', 'col2']);
});

test('restart merge: later segment supersedes overlap', () => {
  const a = FP.parseFoamDat('# Time x\n0 1\n1 1\n2 1\n3 1\n');
  const b = FP.parseFoamDat('# Time x\n2 5\n3 5\n4 5\n');
  const m = FP.mergeSeries([b, a]);
  assert.deepEqual(m.time, [0, 1, 2, 3, 4]);
  assert.deepEqual(m.data.x, [1, 1, 5, 5, 5]);
});

test('windowStats: stationary vs drifting', () => {
  const time = [], flat = [], ramp = [];
  for (let i = 0; i < 200; i++) { time.push(i * 0.1); flat.push(5 + 0.1 * Math.sin(i)); ramp.push(i); }
  const s = { columns: ['flat', 'ramp'], time, data: { flat, ramp } };
  const w = FP.windowStats(s, { lastFraction: 0.5 });
  assert.ok(w.n >= 99 && w.n <= 101);
  assert.equal(w.stats.flat.stationary, true);
  assert.ok(Math.abs(w.stats.flat.mean - 5) < 0.02);
  assert.equal(w.stats.ramp.stationary, false);
  const w2 = FP.windowStats(s, { tStart: 5, tEnd: 10, columns: ['flat'] });
  assert.deepEqual(w2.window, [5, 10]);
  assert.deepEqual(Object.keys(w2.stats), ['flat']);
});

test('loadFunctionObject reads restart dirs from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfpp-'));
  try {
    const fo = path.join(dir, 'postProcessing', 'probes');
    await fs.mkdir(path.join(fo, '0'), { recursive: true });
    await fs.mkdir(path.join(fo, '1.5'), { recursive: true });
    await fs.writeFile(path.join(fo, '0', 'p.dat'), '# Time p\n0 1\n1 1\n2 1\n');
    await fs.writeFile(path.join(fo, '1.5', 'p.dat'), '# Time p\n1.5 9\n2.5 9\n');
    const list = await FP.listFunctionObjects(dir);
    assert.deepEqual(list, [{ name: 'probes', start_times: ['0', '1.5'], files: ['p.dat'] }]);
    const { file, series } = await FP.loadFunctionObject(dir, 'probes');
    assert.equal(file, 'p.dat');
    assert.deepEqual(series.time, [0, 1, 1.5, 2.5]);
    assert.deepEqual(series.data.p, [1, 1, 9, 9]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
