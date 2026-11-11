// v102：脚本内重定向的求解日志、首个 Time 在 1 MB 之后、核数解析、旧调用参数裁剪、模糊说法识别、界面重连复位
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { findTreeLog } from '../external_runs.js';
import * as M from '../monitor.js';
import { isRepro } from '../fidelity.js';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const grab = (text, a, b) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a)));
const P = (pid, ppid, argv) => ({ pid, ppid, pgid: pid, starttime: 1, argv });

test('findTreeLog: solver stdout redirected inside the job script', () => {
  const table = [
    P(10, 1, ['bash', '-c', './Allcold']), P(11, 10, ['/bin/bash', './Allcold']),
    P(12, 11, ['mpirun', '--bind-to', 'none', '-np', '88', 'reactingTwoPhaseEulerFoam', '-parallel']),
    P(13, 12, ['reactingTwoPhaseEulerFoam', '-parallel']),
    P(20, 1, ['mpirun', '-np', '4', 'simpleFoam', '-parallel']),
  ];
  const links = { '/proc/10/fd/1': '/c/log.nullflux.ab', '/proc/11/fd/1': '/c/log.nullflux.ab', '/proc/12/fd/1': '/c/log.cold', '/proc/13/fd/1': '/c/log.cold', '/proc/20/fd/1': '/other/log.run' };
  const fsImpl = {
    readlinkSync: f => { if (f in links) return links[f]; throw new Error('ENOENT'); },
    statSync: () => ({ isFile: () => true }),
  };
  assert.equal(findTreeLog(10, table, '/c/log.nullflux.ab', { fsImpl }), '/c/log.cold');
  assert.equal(findTreeLog(10, table, '/c/log.cold', { fsImpl }), '');
  assert.equal(findTreeLog(99, table, '', { fsImpl }), '');
  links['/proc/12/fd/1'] = '/dev/pts/1'; links['/proc/13/fd/1'] = '/dev/pts/1';
  assert.equal(findTreeLog(10, table, '', { fsImpl }), '');
});

test('firstTime finds the first step beyond the first megabyte and caches it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-'));
  const f = path.join(d, 'log.solver');
  fs.writeFileSync(f, ('Selecting model for phase x\n'.repeat(80000)) + 'Time = 0.00012\n' + 'Courant\n'.repeat(10) + 'Time = 0.5\n');
  assert.ok(fs.statSync(f).size > (2 << 20));
  assert.equal(M.firstTime(f), 0.00012);
  fs.appendFileSync(f, 'Time = 0.75\n');
  assert.equal(M.firstTime(f), 0.00012);
  const g = path.join(d, 'log.partial');
  fs.writeFileSync(g, 'header\nTime = 12');
  assert.equal(M.firstTime(g), 12);
  const h = path.join(d, 'log.none');
  fs.writeFileSync(h, 'ClockTime = 3\n');
  assert.equal(M.firstTime(h), null);
  assert.equal(M.firstTime(path.join(d, 'missing')), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('core count: -np, -n, and mpirun inside a job script', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  fs.writeFileSync(path.join(d, 'Allcold'), '#!/bin/bash\nNP=88\ndecomposePar -force > log.decomposePar 2>&1\nmpirun --bind-to none -np $NP reactingTwoPhaseEulerFoam -parallel > log.cold 2>&1\n');
  fs.writeFileSync(path.join(d, 'run.sh'), 'mpirun -n 16 twoPhaseEulerFoam -parallel\n');
  const ctx = vm.createContext({ fssync: fs, path, os, WORKSPACE: d });
  vm.runInContext(grab(src, 'const _MPI_NP_RE', '\nfunction _cpuOversubscribed').replace(/^const /gm, 'var '), ctx);
  assert.equal(ctx._npOf('mpirun --bind-to none -np 48 reactingTwoPhaseEulerFoam -parallel > log.diag 2>&1'), 48);
  assert.equal(ctx._npOf('mpirun -n 16 twoPhaseEulerFoam -parallel'), 16);
  assert.equal(ctx._npOf('./Allcold', d), 88);
  assert.equal(ctx._npOf('bash run.sh', d), 16);
  assert.equal(ctx._npOf('./Allmissing', d), 1);
  assert.equal(ctx._npOf('simpleFoam > log.run'), 1);
  assert.equal(ctx._npOf('head -n 20 log.cold'), 1);
  // 包装脚本把核数作为位置参数：launch.sh <dir> <np> <in> ...，脚本里 np=$2; mpirun -np $np
  fs.writeFileSync(path.join(d, 'launch.sh'), '#!/bin/bash\ncd "$1" || exit 1\nnp=$2; inp=$3; shift 3\n/usr/bin/time -p mpirun -np $np /x/lmp_auto -in $inp "$@" -log log.liggghts\n');
  assert.equal(ctx._npOf('./launch.sh /home/user/demcase/A/gscan/G0.8 4 in.vib -var f 60', d), 4);
  assert.equal(ctx._npOf('bash launch.sh /a 12 in.vib', d), 12);
  // 直接写 mpirun -np $1 的脚本
  fs.writeFileSync(path.join(d, 'go.sh'), 'mpirun -np $1 ./lmp_auto -in in.x\n');
  assert.equal(ctx._npOf('bash go.sh 8', d), 8);
  // 环境变量前缀 + 脚本默认值：NP=${NP:-60}
  fs.writeFileSync(path.join(d, 'runspeed.sh'), '#!/bin/bash\nNP=${NP:-60}; TL=${TL:-600}\ntimeout -s INT $TL mpirun --bind-to none -np $NP reactingTwoPhaseEulerFoam -parallel > log.speed 2>&1\n');
  assert.equal(ctx._npOf('NP=48 TL=600 ./runspeed.sh', d), 48);
  assert.equal(ctx._npOf('./runspeed.sh', d), 60);
  fs.rmSync(d, { recursive: true, force: true });
});

test('old tool-call arguments are cut to head and tail, recent ones and small ones kept', () => {
  const ctx = vm.createContext({ process });
  vm.runInContext(grab(src, 'const PRUNE_KEEP', '\n// 非流式、无工具的一次性调用').replace(/^const /gm, 'var '), ctx);
  const body = 'A'.repeat(500) + 'x'.repeat(9000) + 'Z'.repeat(200);
  const call = (id, content) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a/b.py', content }) } }] });
  const ms = [{ role: 'system', content: 's' }, call('c1', body), { role: 'tool', tool_call_id: 'c1', content: 'ok' }, call('c2', 'short'), { role: 'tool', tool_call_id: 'c2', content: 'ok' }];
  for (let i = 0; i < 30; i++) ms.push({ role: 'user', content: 'u' + i });
  ms.push(call('c3', body), { role: 'tool', tool_call_id: 'c3', content: 'ok' });
  const s = { messages: ms };
  const before = ms[1];
  const gain = ctx.pruneOldToolResults(s);
  assert.ok(gain > 8000);
  const a = JSON.parse(s.messages[1].tool_calls[0].function.arguments);
  assert.equal(a.path, 'a/b.py');
  assert.ok(a.content.startsWith('A'.repeat(400)) && a.content.endsWith('Z'.repeat(150)) && a.content.length < 700);
  assert.ok(a.content.includes('旧调用参数已裁剪'));
  assert.equal(s.messages[1].tool_calls[0].id, 'c1');
  assert.equal(before.tool_calls[0].function.arguments.length > 9000, true);
  assert.equal(JSON.parse(s.messages[3].tool_calls[0].function.arguments).content, 'short');
  assert.equal(JSON.parse(s.messages[s.messages.length - 2].tool_calls[0].function.arguments).content, body);
  const snap = JSON.stringify(s.messages);
  assert.equal(ctx.pruneOldToolResults(s), 0);
  assert.equal(JSON.stringify(s.messages), snap);
  process.env.PRUNE_ARGS = '0';
  try {
    const t = { messages: [{ role: 'system', content: 's' }, call('d1', body), { role: 'tool', tool_call_id: 'd1', content: 'ok' }, ...Array.from({ length: 30 }, () => ({ role: 'user', content: 'u' }))] };
    assert.equal(ctx.pruneOldToolResults(t), 0);
  } finally { delete process.env.PRUNE_ARGS; }
});

test('loosely worded reproduction requests still switch on the paper kit and the fidelity gate', () => {
  const re = eval(/const _WANT_PAPER_RE = (\/.*\/i);/.exec(src)[1]);
  const tools = eval(/const _WANT_PAPER_TOOLS_RE = (\/.*\/i);/.exec(src)[1]);
  for (const s of ['照着这篇文献把反应器算一下', '按附件这篇文章的条件做一遍，看结果对不对', '把 Smith 2020 的结果重现出来', '复现论文 Smith 2020 的中试 FCC 反应器']) {
    assert.equal(re.test(s), true, s);
    assert.equal(tools.test(s), true, s);
    assert.equal(isRepro(s), true, s);
  }
  for (const s of ['帮我模拟一个流化床', '我们厂的搅拌釜混合不好，能不能算算怎么改', '二维圆柱绕流 Re=100，求 St']) {
    assert.equal(re.test(s), false, s);
    assert.equal(isRepro(s), false, s);
  }
  assert.equal(re.test('完成文献基准算例：Hysing et al. 2009 二维气泡，与文献参考值比较'), false);
});

test('after a reconnect the server idle signal clears a stale running state', () => {
  const calls = [];
  const stop = { disabled: false };
  const sandbox = vm.createContext({
    $: () => stop, setRunning: r => { calls.push(['running', r]); stop.disabled = !r; }, onAgentRunState: r => calls.push(['chrome', r]),
  });
  const body = grab(app, "case 'agent_idle':", '\n');
  vm.runInContext('function h(m) { switch (m.type) { ' + body + ' } }', sandbox);
  sandbox.h({ type: 'agent_idle' });
  assert.deepEqual(calls, [['running', false], ['chrome', false]]);
  sandbox.h({ type: 'agent_idle' });
  assert.equal(calls.length, 2);
  assert.match(src, /if \(!owner\._running\) \{ ws\.send\(JSON\.stringify\(\{ type: 'agent_idle'/);
  assert.match(app, /lastHistoryTask === m\.taskId && !connect\._resync\) return;/);
  assert.match(app, /connect\._resync = true;/);
});

test('read-only commands that only mention mpirun or a job script are not treated as a launch', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'np2-'));
  fs.writeFileSync(path.join(d, 'Allcold'), 'NP=60\nmpirun --bind-to none -np $NP reactingTwoPhaseEulerFoam -parallel > log.cold 2>&1\n');
  const ctx = vm.createContext({ fssync: fs, path, os, WORKSPACE: d });
  vm.runInContext(grab(src, 'const _MPI_NP_RE', '\nfunction _cpuOversubscribed').replace(/^const /gm, 'var '), ctx);
  const launch = c => ctx._MPI_LAUNCH_RE.test(c) || ctx._npOf(c, d) > 1;
  for (const c of ['grep -E "mpirun|-np" Allcold; ps -eo pid,args | grep -E "Foam|mpirun"', 'cat Allcold', 'head -3 Allcold | grep NP', 'ls log.*; tail -5 log.cold', 'grep -c "mpirun -np 60" log.cold']) assert.equal(launch(c), false, c);
  for (const c of ['./Allcold', 'cd x && ./Allcold', 'nohup bash Allcold', 'timeout 900 mpirun --bind-to none -np 48 reactingTwoPhaseEulerFoam -parallel > log.diag 2>&1', 'cd x; mpirun -n 8 simpleFoam -parallel']) assert.equal(launch(c), true, c);
  assert.equal(ctx._npOf('cd x && ./Allcold', d), 60);
  assert.equal(ctx._npOf('timeout 900 mpirun --bind-to none -np 48 reactingTwoPhaseEulerFoam -parallel', d), 48);
  assert.equal(ctx._npOf('grep -E "mpirun|-np" Allcold', d), 1);
  fs.rmSync(d, { recursive: true, force: true });
});
