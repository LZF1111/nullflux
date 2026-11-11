import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solverName, inferExitFromLog, pickCandidates } from '../external_runs.js';

test('LIGGGHTS 可执行文件被识别为求解器', () => {
	assert.equal(solverName(['/home/user/vibtray/bin/lmp_auto', '-in', 'in.patch']), 'lmp_auto');
	assert.equal(solverName(['liggghts', '-in', 'in.x']), 'liggghts');
	assert.equal(solverName(['python3', 'post.py']), '');
});

test('mpirun 下的 lmp_auto rank 不重复登记', () => {
	const table = [
		{ pid: 10, ppid: 1, argv: ['mpirun', '-np', '8', '/home/user/vibtray/bin/lmp_auto', '-in', 'in.patch'] },
		{ pid: 11, ppid: 10, argv: ['/home/user/vibtray/bin/lmp_auto', '-in', 'in.patch'] },
		{ pid: 12, ppid: 10, argv: ['/home/user/vibtray/bin/lmp_auto', '-in', 'in.patch'] },
	];
	const c = pickCandidates(table);
	assert.equal(c.length, 1);
	assert.equal(c[0].pid, 10);
});

test('LIGGGHTS 日志：mpirun 起的 lmp_auto 有 CR 也能识别', () => {
	assert.equal(solverName(['mpirun', '-np', '8', '/home/user/vibtray/bin/lmp_auto', '-in', 'in.patch']), 'lmp_auto');
});

test('server.js: _demLastTime 读 thermo 表的 Time 列', async () => {
	const fs = await import('node:fs');
	const vm = await import('node:vm');
	const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
	const a = src.indexOf('function _demLastTime');
	const b = src.indexOf('function _endedCleanly', a);
	const ctx = {};
	vm.runInNewContext(src.slice(a, b) + '\nthis.f = _demLastTime;', ctx);
	const f = ctx.f;
	const log = [
		'    Step           Time    Atoms         KinEng    zmax     CPU ',
		'   50001       0.050001    13309  3.3654801e-11  0.00056180285       0 ',
		'   60000    0.06    13309  2.2743425e-08  0.00096577238      16.371022 ',
		'Loop time of 12 on 8 procs for 10000 steps with 13309 atoms',
	];
	assert.equal(f(log), '0.06');
	assert.equal(f(['Step KinEng', '100 1e-3']), '');
	assert.equal(f(['Time = 0.5', 'Courant Number mean: 0.1']), '');
	assert.equal(f([]), '');
});

test('LIGGGHTS 日志：正常结束 / ERROR', () => {
	const ok = ['Loop time of 12.3 on 8 procs for 1000 steps with 13309 atoms', '', 'Total wall time: 0:02:03'];
	assert.equal(inferExitFromLog(ok), 0);
	const bad = ['ERROR: Fix particletemplate/sphere (id pts1): Volume expectancy too small.'];
	assert.equal(inferExitFromLog(bad), 1);
	const lost = ['ERROR on proc 3: Lost atoms: original 13309 current 13300 (../thermo.cpp:404)'];
	assert.equal(inferExitFromLog(lost), 1);
});
