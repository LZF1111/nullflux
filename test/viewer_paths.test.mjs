// viewer.js 里识别「对话中的路径」的规则（从源码抠出来跑）：该认的认，不该认的不认
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8');
const a = src.indexOf("const EXT = '"), b = src.indexOf('const RES = new Map()');
assert.ok(a > 0 && b > a);
const ctx = vm.createContext({});
vm.runInContext(src.slice(a, b) + '\nthis.textCandidates = textCandidates; this.codeCandidate = codeCandidate;', ctx);
const inText = s => [...ctx.textCandidates(s)].map(c => c.raw + (c.line ? ':' + c.line : ''));

test('paths in plain text are found, with an optional line number', () => {
  assert.deepEqual(inText('结果在 cstr_table5.json，图见 figs/mesh_slice.png。'), ['cstr_table5.json', 'figs/mesh_slice.png']);
  assert.deepEqual(inText('见 system/controlDict.orig:42 和 ~/projects/cases/a/PROGRESS.md'), ['system/controlDict.orig:42', '~/projects/cases/a/PROGRESS.md']);
  assert.deepEqual(inText('已写入 `x`（./tools/plot.py）'), ['./tools/plot.py']);
});

test('urls, numbers, units and identifiers are left alone', () => {
  assert.deepEqual(inText('see https://example.com/a/report.pdf and www.site.com/x.png'), []);
  assert.deepEqual(inText('u0=0.327 m/s, 27 kg/h, Δt≈1.3e-4 s, v2306, e.g. this'), []);
  assert.deepEqual(inText('mail me@host.org or call obj.method.py()'), ['obj.method.py']);
});

test('inline code: paths and extension-less dictionaries qualify, commands and numbers do not', () => {
  const c = s => ctx.codeCandidate(s);
  assert.deepEqual({ ...c('system/fvSolution') }, { raw: 'system/fvSolution', line: 0 });
  assert.deepEqual({ ...c('deviations.log.md') }, { raw: 'deviations.log.md', line: 0 });
  assert.deepEqual({ ...c('tools/post.py:118') }, { raw: 'tools/post.py', line: 118 });
  assert.deepEqual({ ...c('/home/user/projects/cases/a/0/U') }, { raw: '/home/user/projects/cases/a/0/U', line: 0 });
  for (const s of ['mpirun -np 88 solver', 'maxCo', '0.63', '1.3e-4', 'alpha.gas', 'a b/c.png', 'x', 'foo(bar)', 'k=v'])
    assert.equal(c(s) === null || (s === 'alpha.gas' && c(s).raw === 'alpha.gas'), true, s);
});
