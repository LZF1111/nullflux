import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const fn = name => { const i = src.indexOf(`function ${name}(`); const s = src.lastIndexOf('\n', i) + 1; let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(s, j + 1); };
const ctx = vm.createContext({ Buffer, path, fssync: fs, process, SOLVER_RUNS: new Map(), SOLVER_EVENTS: new EventEmitter(), setInterval, clearInterval, setTimeout, clearTimeout, Date,
  killRunTree: () => {}, _finishRun: () => {} });
for (const n of ['_redirectTarget', '_redirectTail', '_redirectLastTime', '_endedCleanly', '_demLastTime', '_runSummary', 'solverWait']) vm.runInContext(fn(n), ctx);

test('End after the last time step counts as clean even with a non-zero exit', () => {
  assert.equal(ctx._endedCleanly(['Time = 5.99', 'x', 'End', '', 'Finalising parallel run', '*** free(): invalid pointer']), true);
  assert.equal(ctx._endedCleanly(['Time = 5.99', 'FOAM FATAL ERROR']), false);
  assert.equal(ctx._endedCleanly(['End', 'Time = 6']), false);
  const run = { runId: 'a', log: ['Time = 6', 'End', 'mpirun noticed that process rank 1 exited on signal 6'], started: 0, ended: 1000, exitCode: 134, casePath: '/c', command: 'x' };
  assert.match(ctx._runSummary(run, 3), /结果有效，不要重算/);
});

test('clean End is also found in the redirected log file', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  fs.writeFileSync(path.join(d, 'log.twoPhaseEulerFoam'), 'Time = 6\n\nEnd\n\nFinalising parallel run\n[1] #0  Foam::error::printStack\n');
  const run = { runId: 'b', log: ['__NF_EXIT__=134'], started: 0, ended: 1, exitCode: 134, casePath: d, command: 'mpirun -np 6 twoPhaseEulerFoam -parallel > log.twoPhaseEulerFoam 2>&1' };
  assert.match(ctx._runSummary(run, 1), /结果有效/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('mode=all: an early finisher is marked reported and does not end the wait', async () => {
  const mk = id => ({ runId: id, log: [], started: Date.now(), ended: 0, exitCode: null, casePath: '/c', command: 'x' });
  const a = mk('a'), b = mk('b');
  ctx.SOLVER_RUNS.set('a', a); ctx.SOLVER_RUNS.set('b', b);
  const session = { _steerQueue: [] };
  const p = ctx.solverWait({ run_ids: ['a', 'b'], mode: 'all', timeout_s: 10 }, session);
  a.ended = Date.now(); a.exitCode = 0; ctx.SOLVER_EVENTS.emit('ended', 'a');
  assert.equal(a._reported, true);
  setTimeout(() => { b.ended = Date.now(); b.exitCode = 0; ctx.SOLVER_EVENTS.emit('ended', 'b'); }, 300);
  const out = await p;
  assert.match(out, /reason=ended/);
});
