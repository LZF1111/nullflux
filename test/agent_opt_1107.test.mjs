// 11-07 agent 优化：End 后卡住、mode=all 失败提前返回、系统通知不打断、短探测自动延长、diagnose_error 误报、启动前体检、head/tail 输出
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { checkControlDict, prelaunchCheck } from '../foam_prelaunch.js';
import { inferExitFromLog } from '../external_runs.js';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const fn = name => { const i = src.indexOf(`function ${name}(`); assert.ok(i > 0, name); const s = src.lastIndexOf('\n', i) + 1; let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(s, j + 1); };
const killed = [];
const ctx = vm.createContext({ Buffer, path, fssync: fs, process, SOLVER_RUNS: new Map(), SOLVER_EVENTS: new EventEmitter(), setInterval, clearInterval, setTimeout, clearTimeout, Date,
  killRunTree: r => killed.push(r.runId), _finishRun: (r, c) => { r.ended = Date.now(); r.exitCode = r._markExit ?? c; } });
for (const n of ['_redirectTarget', '_redirectTail', '_redirectLastTime', '_endedCleanly', '_demLastTime', '_runSummary', 'solverWait', 'headTailBuffer', '_textEndedCleanly']) vm.runInContext(fn(n), ctx);
const mk = (id, extra = {}) => ({ runId: id, log: [], _lineNo: 0, started: Date.now(), ended: 0, exitCode: null, casePath: '/nonexistent-case', command: 'x', ...extra });

test('End then hang: solver_wait settles it as finished', async () => {
  process.env.END_HANG_MS = '300';
  try {
    const a = mk('h1', { log: ['Time = 6', 'End', 'Finalising parallel run'], _lineNo: 3 });
    ctx.SOLVER_RUNS.set('h1', a);
    const out = await ctx.solverWait({ run_ids: ['h1'], mode: 'all', timeout_s: 20, allow_short: true }, {});
    assert.match(out, /reason=ended/);
    assert.equal(a.exitCode, 0);
    assert.equal(a.endAbort, true);
    assert.ok(killed.includes('h1'));
  } finally { delete process.env.END_HANG_MS; }
});

test('mode=all returns early when one job fails, and names the ones still running', async () => {
  const a = mk('f1'), b = mk('f2');
  ctx.SOLVER_RUNS.set('f1', a); ctx.SOLVER_RUNS.set('f2', b);
  const p = ctx.solverWait({ run_ids: ['f1', 'f2'], mode: 'all', timeout_s: 20, allow_short: true }, {});
  setTimeout(() => { a.ended = Date.now(); a.exitCode = 1; ctx.SOLVER_EVENTS.emit('ended', 'f1'); }, 200);
  const out = await p;
  assert.match(out, /reason=failed\(f1\)/);
  assert.match(out, /仍在运行: f2/);
});

test('a system job-finished note does not interrupt mode=all; a user message does', async () => {
  const a = mk('s1'), b = mk('s2');
  ctx.SOLVER_RUNS.set('s1', a); ctx.SOLVER_RUNS.set('s2', b);
  const sess = { _steerQueue: [{ text: '[系统·后台作业结束]', system: true }] };
  const p = ctx.solverWait({ run_ids: ['s1', 's2'], mode: 'all', timeout_s: 20, allow_short: true }, sess);
  setTimeout(() => sess._steerQueue.push({ text: '用户插话' }), 1500);
  const out = await p;
  assert.match(out, /reason=steer/);
  assert.ok(Date.now() - a.started >= 1400);
});

test('short probe waits on running jobs are stretched to 1800 s', async () => {
  const a = mk('p1', { log: ['Time = 0.01'], _lineNo: 1 });
  ctx.SOLVER_RUNS.set('p1', a);
  const p = ctx.solverWait({ run_ids: ['p1'], timeout_s: 90 }, {});
  setTimeout(() => { a.ended = Date.now(); a.exitCode = 0; ctx.SOLVER_EVENTS.emit('ended', 'p1'); }, 100);
  assert.match(await p, /已自动延长到 1800 s/);
});

test('until_regex uses an absolute cursor across the 4000-line cap', async () => {
  const a = mk('c1', { log: Array.from({ length: 4000 }, (_, i) => `Time = ${i}`), _lineNo: 9000 });
  ctx.SOLVER_RUNS.set('c1', a);
  const p = ctx.solverWait({ run_ids: ['c1'], timeout_s: 20, until_regex: '^MARK$', allow_short: true }, {});
  setTimeout(() => { a.log.splice(0, 10); a.log.push(...Array(9).fill('x'), 'MARK'); a._lineNo += 10; }, 1200);
  assert.match(await p, /matched\(c1\): MARK/);
});

test('head/tail buffer keeps the end of long output', () => {
  const b = ctx.headTailBuffer(100, 200);
  for (let i = 0; i < 1000; i++) b.push(`line${i}\n`);
  const s = b.toString();
  assert.ok(s.startsWith('line0'));
  assert.ok(s.trimEnd().endsWith('line999'));
  assert.match(s, /中间省略/);
  assert.ok(s.length < 400);
});

test('external runs: End after the last time step is success even with abort noise', () => {
  assert.equal(inferExitFromLog(['Time = 6', 'End', 'Finalising parallel run', '[1] FOAM aborting', 'MPI_ABORT was invoked']), 0);
  assert.equal(inferExitFromLog(['Time = 6', '--> FOAM FATAL ERROR:', 'FOAM aborting']), 1);
});

test('controlDict check: adjustTimeStep with writeControl runTime is flagged', () => {
  const bad = 'adjustTimeStep yes;\nwriteControl runTime;\nwriteInterval 0.1;\nendTime 6;\n';
  assert.equal(checkControlDict(bad).issues.length, 1);
  const good = 'adjustTimeStep yes;\nwriteControl adjustableRunTime;\nwriteInterval 0.1;\nendTime 6;\n';
  assert.equal(checkControlDict(good).issues.length, 0);
  assert.equal(checkControlDict('writeControl runTime;\nwriteInterval 0.4;\nendTime 1;\n').issues.length, 1);
});

test('prelaunch reports initial T and p from 0/', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
  fs.mkdirSync(path.join(d, 'system')); fs.mkdirSync(path.join(d, '0'));
  fs.writeFileSync(path.join(d, 'system', 'controlDict'), 'writeControl runTime;\nwriteInterval 1;\nendTime 6;\n');
  fs.writeFileSync(path.join(d, '0', 'T.air'), 'internalField uniform 600;\n');
  fs.writeFileSync(path.join(d, '0', 'p'), 'internalField uniform 1e5;\n');
  const r = await prelaunchCheck(d);
  assert.equal(r.facts['0/T.air'], '600');
  assert.equal(r.facts['0/p'], '1e5');
  fs.rmSync(d, { recursive: true, force: true });
});

test('diagnose_error: routine continuity lines and post-End abort are not errors', () => {
  const dctx = vm.createContext({ SkillLib: { learnedErrorPatterns: () => [] } });
  const a = src.indexOf('const ERROR_PATTERNS'); const b = src.indexOf('// 算法契约抽取');
  vm.runInContext(src.slice(a, b).replace(/^const ERROR_PATTERNS/m, 'var ERROR_PATTERNS'), dctx);
  const r1 = dctx.diagnoseErrorText('time step continuity errors : sum local = 2.3e-09, global = 1e-12, cumulative = 3e-10\nTime = 1');
  assert.equal(r1.matched, false);
  const r2 = dctx.diagnoseErrorText('Time = 6\nEnd\nFinalising\n[1] Foam::error::printStack\nFOAM aborting');
  assert.match(r2.hits[0].category, /非错误/);
  const r3 = dctx.diagnoseErrorText('Time step continuity errors : sum local = 0.35, global = 0.1, cumulative = 3');
  assert.ok(r3.hits.some(h => /漂移/.test(h.category)));
  const r4 = dctx.diagnoseErrorText('deltaT = 3.2e-09\nTime = 0.0123');
  assert.ok(r4.hits.some(h => /时间步崩塌/.test(h.category)));
});

test('benchmark tasks that only cite a reference value do not pull in the paper-reproduction kit', () => {
  const m = /const _WANT_PAPER_RE = (\/.*\/i);/.exec(src);
  const re = eval(m[1]);
  assert.equal(re.test('完成文献基准算例：Hysing et al. 2009 二维气泡，与文献参考值比较'), false);
  assert.equal(re.test('复现论文 Lu 2016 的 DMTO 曳力模型'), true);
  assert.equal(re.test('读一下这篇 paper.pdf 的边界条件'), true);
});

test('exit 1 with empty output (grep miss) does not count as a session error', () => {
  const ectx = vm.createContext({});
  vm.runInContext(fn('sessionHadError'), ectx);
  assert.equal(ectx.sessionHadError({ messages: [{ role: 'tool', content: '[退出码 1]\n' }] }), false);
  assert.equal(ectx.sessionHadError({ messages: [{ role: 'tool', content: '[退出码 1]\n--> FOAM FATAL ERROR: x' }] }), true);
  assert.equal(ectx.sessionHadError({ messages: [{ role: 'tool', content: '[退出码 2]\nbad' }] }), true);
});
