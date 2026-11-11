// path_resolve：对话里提到的路径 → 工作区内真实文件
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMentioned } from '../path_resolve.js';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pres-'));
  const put = (rel, text = 'x') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('cases/a/system/controlDict');
  put('cases/a/figs/mesh_slice.png', 'png');
  put('cases/a/params_lock.json');
  put('cases/a/PROGRESS.md', 'case');
  put('cases/a/processor0/0/U');
  put('cases/a/tools/plot.py');
  put('cases/a/post/plot.py');
  put('cases/b/params_lock.json');
  put('PROGRESS.md', 'root');
  put('0/U');
  return root;
}

test('workspace-relative and absolute paths resolve; outside paths never do', async () => {
  const root = workspace();
  const outside = path.join(os.tmpdir(), 'pres-outside.txt'); fs.writeFileSync(outside, 'x');
  const found = await resolveMentioned({ workspace: root, paths: [
    'cases/a/system/controlDict', './cases/a/params_lock.json', path.join(root, 'cases', 'a', 'figs', 'mesh_slice.png'),
    '../' + path.basename(outside), outside, 'cases/a/missing.txt', 'kg/h', '0/U', 'cases\\a\\params_lock.json',
  ] });
  assert.equal(found['cases/a/system/controlDict'].path, 'cases/a/system/controlDict');
  assert.equal(found['./cases/a/params_lock.json'].path, 'cases/a/params_lock.json');
  assert.equal(found[path.join(root, 'cases', 'a', 'figs', 'mesh_slice.png')].path, 'cases/a/figs/mesh_slice.png');
  assert.equal(found['0/U'].path, '0/U');
  assert.equal(found['cases\\a\\params_lock.json'].path, 'cases/a/params_lock.json');
  assert.deepEqual(Object.keys(found).length, 5);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true });
});

test('paths relative to the case directory resolve through bases', async () => {
  const root = workspace();
  const found = await resolveMentioned({ workspace: root, bases: ['cases/a'], paths: ['figs/mesh_slice.png', 'system/controlDict', 'system'] });
  assert.equal(found['figs/mesh_slice.png'].path, 'cases/a/figs/mesh_slice.png');
  assert.equal(found['figs/mesh_slice.png'].size, 3);
  assert.equal(found['system/controlDict'].path, 'cases/a/system/controlDict');
  assert.equal(found.system.isDir, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bare file name prefers the case directory, then a unique match below it', async () => {
  const root = workspace();
  const found = await resolveMentioned({ workspace: root, bases: [path.join(root, 'cases', 'a')], paths: ['PROGRESS.md', 'params_lock.json', 'mesh_slice.png', 'plot.py', 'U', 'nothing.png'] });
  assert.equal(found['PROGRESS.md'].path, 'cases/a/PROGRESS.md');
  assert.equal(found['params_lock.json'].path, 'cases/a/params_lock.json');
  assert.equal(found['mesh_slice.png'].path, 'cases/a/figs/mesh_slice.png');
  assert.equal(found['plot.py'], undefined, 'two files share the name: ambiguous, not linked');
  assert.equal(found.U, undefined, 'processor and time directories are not searched');
  assert.equal(found['nothing.png'], undefined);
  const noBase = await resolveMentioned({ workspace: root, paths: ['PROGRESS.md', 'mesh_slice.png'] });
  assert.equal(noBase['PROGRESS.md'].path, 'PROGRESS.md');
  assert.equal(noBase['mesh_slice.png'], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bases outside the workspace and junk input are ignored', async () => {
  const root = workspace();
  const found = await resolveMentioned({ workspace: root, bases: [os.tmpdir(), '..', 42, ''], paths: [null, '', 'a'.repeat(500), 'PROGRESS.md'] });
  assert.deepEqual(Object.keys(found), ['PROGRESS.md']);
  assert.deepEqual(await resolveMentioned({ workspace: root, paths: 'nope' }), Object.create(null));
  fs.rmSync(root, { recursive: true, force: true });
});
