import test from 'node:test';
import assert from 'node:assert/strict';
import { solverName, readProcTable, pickCandidates, resolveLog, inferExitFromLog, processStartMs } from '../external_runs.js';

test('recognizes solver commands', () => {
  assert.equal(solverName(['mpirun', '--bind-to', 'none', '-np', '32', 'reactingTwoPhaseEulerFoam', '-parallel']), 'reactingTwoPhaseEulerFoam');
  assert.equal(solverName(['/opt/of/bin/simpleFoam']), 'simpleFoam');
  assert.equal(solverName(['foamRun', '-solver', 'fluid']), 'foamRun');
  assert.equal(solverName(['paraFoam']), '');
  assert.equal(solverName(['foamToVTK']), '');
  assert.equal(solverName(['bash', 'run.sh']), '');
});

const P = (pid, ppid, argv, pgid = pid) => ({ pid, ppid, pgid, starttime: 100, argv });

test('picks mpirun roots, skips ranks and our own descendants', () => {
  const table = [
    P(1, 0, ['/sbin/init']),
    P(100, 1, ['mpirun', '-np', '2', 'reactingTwoPhaseEulerFoam', '-parallel']),
    P(101, 100, ['reactingTwoPhaseEulerFoam', '-parallel']),
    P(102, 100, ['reactingTwoPhaseEulerFoam', '-parallel']),
    P(200, 1, ['simpleFoam']),
    P(300, 1, ['node', 'server.js']),
    P(301, 300, ['bash', '-c', 'cd x; pimpleFoam']),
    P(302, 301, ['pimpleFoam']),
    P(400, 1, ['mpirun', '-np', '2', 'pimpleFoam']),
    P(401, 400, ['orted']),
    P(402, 401, ['pimpleFoam', '-parallel']),
  ];
  const got = pickCandidates(table, new Set([300])).map(c => c.pid).sort((a, b) => a - b);
  assert.deepEqual(got, [100, 200, 400]);
});

function fakeFs(files, links = {}, dirs = {}) {
  return {
    readdirSync: d => { if (dirs[d]) return dirs[d]; throw new Error('ENOENT'); },
    readFileSync: f => { if (f in files) return files[f]; throw new Error('ENOENT ' + f); },
    readlinkSync: f => { if (f in links) return links[f]; throw new Error('ENOENT'); },
    statSync: f => { const s = files[f]; if (s === undefined) throw new Error('ENOENT'); return { isFile: () => true, mtimeMs: typeof s === 'object' ? s.m : 0 }; },
  };
}

test('reads /proc table with spaces in comm', () => {
  const fsImpl = fakeFs({
    '/proc/42/cmdline': ['mpirun', '-np', '4', 'simpleFoam', ''].join('\0'),
    '/proc/42/stat': '42 (my (odd) name) S 1 42 42 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0',
    '/proc/43/cmdline': '',
  }, {}, { '/proc': ['42', '43', 'self', 'stat'] });
  const t = readProcTable('/proc', fsImpl);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].pid, t[0].ppid, t[0].pgid, t[0].starttime], [42, 1, 42, 12345]);
  assert.deepEqual(t[0].argv, ['mpirun', '-np', '4', 'simpleFoam']);
});

test('resolves log from stdout redirect, else recent log* in cwd', () => {
  let fsImpl = fakeFs({ '/case/log.run': { m: 0 } }, { '/proc/9/fd/1': '/case/log.run' });
  assert.equal(resolveLog(9, '/case', { fsImpl }), '/case/log.run');
  fsImpl = fakeFs({ '/case/log.old': { m: 1000 }, '/case/log.new': { m: 5000 } }, { '/proc/9/fd/1': '/dev/pts/3' }, { '/case': ['log.old', 'log.new', 'system'] });
  assert.equal(resolveLog(9, '/case', { fsImpl, now: 6000 }), '/case/log.new');
  assert.equal(resolveLog(9, '/case', { fsImpl, now: 5000 + 11 * 60_000 }), null);
});

test('start time from btime', () => {
  const fsImpl = fakeFs({ '/proc/stat': 'cpu 1 2 3\nbtime 1700000000\n' });
  assert.equal(processStartMs(12345, { fsImpl }), (1700000000 + 123.45) * 1000);
});

test('infers exit code from log tail', () => {
  assert.equal(inferExitFromLog(['Time = 1', 'ExecutionTime = 3 s', 'End', '']), 0);
  assert.equal(inferExitFromLog(['--> FOAM FATAL ERROR:', 'End']), 1);
  assert.equal(inferExitFromLog(['mpirun noticed that process rank 3 with PID 0 on node x exited on signal 11']), 1);
  assert.equal(inferExitFromLog(['Time = 119.3']), null);
});
