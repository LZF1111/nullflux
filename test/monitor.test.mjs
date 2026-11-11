import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../monitor.js';

test('lastTime / lastStepInfo parse OpenFOAM log tail', () => {
  const log = 'Courant Number mean: 0.01 max: 0.42\ndeltaT = 0.0002\nTime = 118.9\n\nCourant Number mean: 0.02 max: 0.55\ndeltaT = 0.00021\nTime = 118.90021\n';
  assert.equal(M.lastTime(log), 118.90021);
  const s = M.lastStepInfo(log);
  assert.equal(s.coMax, 0.55); assert.equal(s.deltaT, 0.00021); assert.equal(s.fatal, false);
  assert.equal(M.lastStepInfo(log + '--> FOAM FATAL ERROR\n').fatal, true);
  assert.equal(M.lastTime('no time here'), null);
});

test('rateFromLog pairs Time with the following ClockTime', () => {
  const log = 'Time = 100\nExecutionTime = 1 s  ClockTime = 0 s\nTime = 100.1\nExecutionTime = 2 s  ClockTime = 1800 s\nTime = 100.2\n';
  assert.ok(Math.abs(M.rateFromLog(log) - 0.2) < 1e-12);           // 0.1 s 物理 / 0.5 h
  assert.equal(M.rateFromLog('Time = 1\n'), null);
});

test('RateTracker: physical s per wall hour, resets on time going back', () => {
  const r = new M.RateTracker();
  r.add('a', 100, 0); assert.equal(r.rate('a'), null);
  r.add('a', 100.25, 3.6e6);                       // 1 h → 0.25 s
  assert.ok(Math.abs(r.rate('a') - 0.25) < 1e-12);
  r.add('a', 50, 3.7e6); assert.equal(r.rate('a'), null);
});

test('progress and ETA', () => {
  const p = M.progress({ start: 118, end: 121, now: 119.5, rate: 0.5 });
  assert.equal(p.frac, 0.5); assert.equal(p.etaH, 3);
  assert.deepEqual(M.progress({ start: null, end: null, now: 1, rate: 1 }), { frac: null, etaH: null });
});

test('readEndTime and rsiSnapshot read a synthetic archive', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'));
  fs.mkdirSync(path.join(d, 'trials', 'abc', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'trials', 'abc', 'system'), { recursive: true });
  fs.writeFileSync(path.join(d, 'trials', 'abc', 'system', 'controlDict'), 'startTime       118.8;\nendTime         121.8;\n');
  fs.writeFileSync(path.join(d, 'trials', 'abc', 'logs', 'solve.stdout.log'), 'Time = 119\n');
  fs.writeFileSync(path.join(d, 'archive.json'), JSON.stringify({ champion: null, control: null, cells: {},
    trials: { abc: { hash: 'abc', cell: 'n4-r1', state: 'running', control: true, features: { n_holes: 211 }, started: 1 } } }));
  fs.writeFileSync(path.join(d, 'campaign.log'), '{"round":0,"proposed":3,"picked":["x"]}\nnot json\n');
  assert.deepEqual(M.readEndTime(path.join(d, 'trials', 'abc')), { start: 118.8, end: 121.8 });
  assert.equal(M.firstTime(path.join(d, 'trials', 'abc', 'logs', 'solve.stdout.log')), 119);
  const s = M.rsiSnapshot(d);
  assert.equal(s.trials.length, 1); assert.equal(s.trials[0].stage, 'solve'); assert.equal(s.trials[0].n_holes, 211);
  assert.ok(s.trials[0].solveLog.endsWith('solve.stdout.log'));
  assert.equal(s.rounds.length, 1);
  assert.equal(M.rsiSnapshot(path.join(d, 'missing')), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('jobAlerts flags FATAL, Courant over limit and stale logs; AlertGate dedupes', () => {
  assert.deepEqual(M.jobAlerts({ fatal: false, coMax: 0.4, logAgeS: 10, frac: 0.5 }, { maxCo: 0.4 }), []);
  const a = M.jobAlerts({ fatal: true, coMax: 1.5, logAgeS: 900, frac: 0.5 }, { maxCo: 0.4 }).map(x => x.kind);
  assert.deepEqual(a, ['fatal', 'courant', 'stale']);
  assert.deepEqual(M.jobAlerts({ logAgeS: 900, frac: 1 }).map(x => x.kind), []);   // 跑完了不算停更
  const g = new M.AlertGate(1000);
  assert.equal(g.should('k', 0), true); assert.equal(g.should('k', 500), false); assert.equal(g.should('k', 1500), true);
});

test('caseOverview reads solver, cells over processors, patches and results', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-'));
  fs.mkdirSync(path.join(d, 'system'), { recursive: true });
  fs.writeFileSync(path.join(d, 'system', 'controlDict'), 'application     reactingTwoPhaseEulerFoam;\nendTime 121.8;\nmaxCo 0.4;\n');
  const bnd = 'FoamFile\n{\n version 2.0;\n}\n3\n(\n    walls\n    {\n        type wall;\n        nFaces 10;\n    }\n    inlet { type patch; }\n    procBoundary0to1 { type processor; }\n)\n';
  for (const p of ['processor0', 'processor1']) {
    const m = path.join(d, p, 'constant', 'polyMesh'); fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, 'owner'), 'FoamFile { note "nPoints:10  nCells:100  nFaces:300"; }\n');
    fs.writeFileSync(path.join(m, 'boundary'), bnd);
    fs.mkdirSync(path.join(d, p, '118.5'), { recursive: true });
  }
  fs.writeFileSync(path.join(d, 'fig12_post.json'), '{}');
  const o = M.caseOverview(d);
  assert.equal(o.application, 'reactingTwoPhaseEulerFoam'); assert.equal(o.nProcs, 2); assert.equal(o.nCells, 200);
  assert.equal(o.latestTime, 118.5); assert.equal(o.maxCo, 0.4);
  assert.deepEqual(o.patches, [{ name: 'walls', type: 'wall' }, { name: 'inlet', type: 'patch' }]);
  assert.deepEqual(o.results, ['fig12_post.json']);
  fs.rmSync(d, { recursive: true, force: true });
});
