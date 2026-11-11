// 真实的 runShell（从 server.js 抠出）：超时后整棵进程树被终止；带后台作业的命令只终止 shell
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const posix = process.platform !== 'win32';

function harness() {
  const term = [];
  const ctx = vm.createContext({
    spawn, path, crypto, process, setTimeout, clearTimeout, setInterval, clearInterval, JSON,
    IS_WIN: !posix, SETTINGS: Object.create(null), WORKSPACE: process.cwd(),
    SOLVER_RUNS: new Map(), allClients: [], broadcastTree() { return 0; },
  });
  vm.runInContext(slice('function headTailBuffer(', '// 超长的工具输出'), ctx);
  vm.runInContext(slice('const _SOLVER_EXE', 'function classifySolverError('), ctx);
  vm.runInContext(slice('// 杀进程树', '\nasync function undoEdit'), ctx);
  const ws = { send: d => term.push(JSON.parse(d).line) };
  const session = { currentProc: null };
  return { ctx, ws, session, term };
}
const pidsOf = tag => {
  try { return execSync(`pgrep -a -x sleep | grep -F " ${tag}" | cut -d" " -f1`).toString().split('\n').filter(Boolean); } catch (e) { return []; }
};
const alive = tag => pidsOf(tag).length > 0;

test('a plain command returns its exit code and output', { skip: !posix }, async () => {
  const h = harness();
  const out = await h.ctx.runShell('echo hello; exit 3', 5000, h.session, h.ws);
  assert.match(out, /^\[退出码 3\]\nhello/);
  assert.equal(h.session.currentProc, null);
});

test('timeout kills the command together with its children and tells the model', { skip: !posix }, async () => {
  const h = harness();
  const t0 = Date.now();
  const out = await h.ctx.runShell('bash -c "sleep 41.37; echo inner" ; echo outer', 1200, h.session, h.ws);
  assert.ok(Date.now() - t0 < 8000, 'returned in ' + (Date.now() - t0) + ' ms');
  assert.match(out, /^\[命令超时：1 s/);
  assert.doesNotMatch(out, /inner|outer/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(alive('41.37'), false, 'grandchild sleep must be gone');
});

test('a command that backgrounds a job keeps that job alive after timeout', { skip: !posix }, async () => {
  const h = harness();
  const t0 = Date.now();
  const out = await h.ctx.runShell('nohup sleep 42.59 >/dev/null 2>&1 & echo started', 4000, h.session, h.ws);
  assert.ok(Date.now() - t0 < 3500, 'returned in ' + (Date.now() - t0) + ' ms');
  assert.match(out, /started/);
  assert.equal(alive('42.59'), true, 'background job must survive');
  for (const pid of pidsOf('42.59')) process.kill(Number(pid));
});

test('stop on a plain command kills the whole group', { skip: !posix }, async () => {
  const h = harness();
  const p = h.ctx.runShell('bash -c "sleep 43.11"; echo after', 60000, h.session, h.ws);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(h.session.currentProc._isSolver, false);
  h.ctx._killProcTree(h.session.currentProc);
  const out = await p;
  assert.doesNotMatch(out, /after/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(alive('43.11'), false);
});

test('solver launch commands are flagged so stop/timeout leave the computation alone', () => {
  const h = harness();
  assert.equal(h.ctx.isSolverLaunchCommand('cd case && mpirun -np 88 reactingTwoPhaseEulerFoam -parallel > log 2>&1'), true);
  assert.equal(h.ctx.isSolverLaunchCommand('tail -n 50 log.reactingTwoPhaseEulerFoam'), false);
});
