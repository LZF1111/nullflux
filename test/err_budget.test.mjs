// HC-4 错误预算：只有求解/网格运行失败才计数；读日志碰到 FATAL 字样不算；未归类的错误按内容区分
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ SkillLib: { learnedErrorPatterns: () => [] } });
const a = src.indexOf('const ERROR_PATTERNS'); const b = src.indexOf('// 算法契约抽取');
assert.ok(a > 0 && b > a);
vm.runInContext(src.slice(a, b).replace(/^const ERROR_PATTERNS/m, 'var ERROR_PATTERNS'), ctx);
const { isSolverLaunchCommand: launch, classifySolverError: classify } = ctx;
const FATAL = '--> FOAM FATAL IO ERROR: (openfoam-2306)\nEntry \'div(phi,U)\' not found in dictionary "/home/x/case/system/fvSchemes/divSchemes"\n';

test('read-only commands that merely show an error are not solver launches', () => {
  for (const c of [
    'cd ~/cases/pilot3D && sed -n 1,400p deviations.log.md | head -150',
    'cd c && grep -n "FOAM FATAL" log.reactingTwoPhaseEulerFoam | tail -3',
    'tail -n 200 log.snappyHexMesh',
    'cat log.blockMesh; ls',
    'python3 tools/post.py --case c',
    'cd c && foamDictionary system/controlDict -entry endTime -set 100',
  ]) assert.equal(launch(c), false, c);
});

test('real solver and mesh launches are recognised', () => {
  for (const c of [
    'cd c && mpirun -np 88 reactingTwoPhaseEulerFoam -parallel > log 2>&1',
    'source ~/OpenFOAM/OpenFOAM-v2306/etc/bashrc && cd c && blockMesh > log.blockMesh 2>&1',
    'cd c && nohup simpleFoam > log &',
    'cd c && ./Allrun',
    'cd c && bash Allmesh',
    'cd c && timeout 600 snappyHexMesh -overwrite',
    'cd c && decomposePar -force',
  ]) assert.equal(launch(c), true, c);
});

test('reading a log through run_command does not count against the budget', () => {
  assert.equal(classify('run_command', { command: 'cd c && tail -50 log.simpleFoam' }, FATAL), null);
  assert.ok(classify('run_command', { command: 'cd c && simpleFoam > log 2>&1; tail log' }, FATAL));
});

test('a post-End abort is not an error', () => {
  assert.equal(classify('foam_solver_status', { run_id: 'aaaaaaaa' }, 'Time = 6\nEnd\nFinalising\nFOAM aborting'), null);
});

test('unclassified errors are told apart by their message', () => {
  const x = classify('foam_run_solver_async', {}, '--> FOAM FATAL ERROR: (openfoam-2306)\nSome brand new problem in patch inlet7\n');
  const y = classify('foam_run_solver_async', {}, '--> FOAM FATAL ERROR: (openfoam-2306)\nA completely different failure about zones\n');
  const x2 = classify('foam_run_solver_async', {}, '--> FOAM FATAL ERROR: (openfoam-2306)\nSome brand new problem in patch inlet9\n');
  assert.notEqual(x.cat, y.cat);
  assert.equal(x.cat, x2.cat);
});

test('status polls of one failed run share a once-key', () => {
  const r1 = classify('foam_solver_status', { run_id: 'deadbeef' }, '已结束(exit=1)\n' + FATAL);
  const r2 = classify('solver_wait', { run_ids: ['deadbeef'] }, '已结束(exit=1)\n' + FATAL);
  assert.ok(r1.once && r1.once === r2.once);
  assert.equal(classify('foam_run_solver_async', {}, FATAL).once, null);
});
