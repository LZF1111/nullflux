import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as O from '../orchestration.js';

test('physical cores ignore hyperthread siblings', () => {
	const ci = [0, 1, 2, 3].map(p => `processor : ${p}\nphysical id : 0\ncore id : ${p % 2}\n`).join('\n');
	assert.equal(O.physicalCoresFromCpuinfo(ci), 2);
	assert.equal(O.physicalCores(4, ci), 2);
	assert.equal(O.physicalCores(8, ''), 8);
});

test('claims: expired ignored, own claims not counted as starting', () => {
	const now = 1_000_000_000;
	const raw = JSON.stringify({ a: { np: 48, t: now / 1000 - 60, owner: 'x' }, b: { np: 8, t: now / 1000 - 99999, owner: 'y', max_age: 100 }, c: { np: 6, t: now / 1000 - 30, owner: 'me' } });
	const c = O.readClaims('f', now, () => raw);
	assert.deepEqual(Object.keys(c).sort(), ['a', 'c']);
	assert.equal(O.startingClaims(c, 'me'), 48);
	assert.equal(O.startingClaims(null, 'me'), 0);
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl')), 'claims.json');
	O.writeClaim(f, 'k', { np: 4, t: 1, owner: 'me' });
	assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).k.np, 4);
	O.writeClaim(f, 'k', null);
	assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), {});
});

test('queue: FIFO, backfill small jobs, stop backfilling after hold', () => {
	const q = [{ id: 'big', np: 60, since: 0 }, { id: 'small', np: 8, since: 10 }];
	assert.equal(O.queuePick(q, 70, 100).id, 'big');
	assert.equal(O.queuePick(q, 10, 100).id, 'small');
	assert.equal(O.queuePick(q, 10, 3 * 3600_000), null);
	assert.equal(O.queuePick([], 96), null);
});

test('streamOf groups jobs by top-level folder', () => {
	const o = { home: '/home/u', workspace: '/home/u/ws' };
	assert.equal(O.streamOf('/home/u/bubble_col/swarm_p1/s3', o), 'bubble_col');
	assert.equal(O.streamOf('/home/u/ws/case1', o), 'ws');
	assert.equal(O.streamOf('C:\\x\\y', {}), 'C:');
});

test('subagent tool policy and custom agent files', () => {
	const { explore, general } = O.BUILTIN_AGENTS;
	assert.equal(O.childToolAllowed(explore, 'read_file'), true);
	assert.equal(O.childToolAllowed(explore, 'write_file'), false);
	assert.equal(O.childToolAllowed(general, 'write_file'), true);
	for (const n of ['subagent', 'foam_run_solver_async', 'foam_solver_stop', 'task_complete', 'opt_run_trial', 'skill_save'])
		assert.equal(O.childToolAllowed(general, n), false, n);
	assert.equal(O.childToolAllowed(general, 'write_file', { parentReadonly: true }), false);
	const a = O.parseAgentFile('mesh', '---\ndescription: 网格检查\ntools: readonly\nsteps: 500\n---\n只看网格。');
	assert.equal(a.readonly, true);
	assert.equal(a.steps, 120);
	assert.match(a.system, /只看网格/);
	assert.equal(O.parseAgentFile('p', '---\nmode: primary\n---\nx'), null);
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ag'));
	fs.writeFileSync(path.join(d, 'Post.md'), '---\ntools: all\n---\n后处理');
	const all = O.loadAgents(d);
	assert.equal(all.post.readonly, false);
	assert.ok(all.explore && all.general);
	assert.ok(O.loadAgents(path.join(d, 'none')).explore);
});

test('result wrapping, model refs, notes, indent errors', () => {
	const ms = [{ role: 'system', content: 's' }, { role: 'assistant', content: '结论 A' }, { role: 'tool', content: 't' }, { role: 'assistant', content: '' }];
	assert.equal(O.lastAssistantText(ms), '结论 A');
	const w = O.wrapResult({ id: 'c1', agent: 'explore', state: 'completed', description: 'say "hi"', text: '' });
	assert.match(w, /^<subagent sessionID="c1" agent="explore" state="completed" description="say 'hi'">/);
	assert.match(w, /没有文本回复/);
	assert.deepEqual(O.parseModelRef('p1/a/b', [{ id: 'p1' }]), { provider: 'p1', model: 'a/b' });
	assert.deepEqual(O.parseModelRef('org/model'), { provider: 'main', model: 'org/model' });
	assert.equal(O.parseModelRef(''), null);
	assert.equal(O.notesBlock('  '), '');
	assert.match(O.notesBlock('x'.repeat(9000), 1000), /中间省略/);
	assert.ok(O.looksLikePythonIndentError('IndentationError: unexpected indent'));
	assert.ok(!O.looksLikePythonIndentError('ok'));
});
