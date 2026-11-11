import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const ctx = vm.createContext({ process });
vm.runInContext(grab('const TOOLS = [', '\nconst NEEDS_APPROVAL').replace(/^const /gm, 'var '), ctx);
const all = () => ctx.filterTools(new Set([...ctx.DEFAULT_ENABLED, ...ctx.TOOL_GROUPS.foam, ...ctx.TOOL_GROUPS.opt]));
const names = (l) => l.map(t => t.function.name);

test('lean tool set drops topic tools a plain CFD task does not need', () => {
  const s = { messages: [{ role: 'user', content: '二维圆柱绕流 Re=100，求 St' }] };
  const n = names(ctx.leanTools(all(), s));
  assert.ok(n.length < all().length - 20);
  for (const t of ['run_command', 'foam_run_solver_async', 'solver_wait', 'foam_mesh_verify', 'task_complete', 'diagnose_error']) assert.ok(n.includes(t), t);
  for (const t of ['opt_study_create', 'skill_export_sft', 'foam_stl_generate']) assert.ok(!n.includes(t), t);
});

test('lean tool set keeps topic tools when the task asks for them or they were used', () => {
  const s = { messages: [{ role: 'user', content: '对 STL 几何做贝叶斯优化' }] };
  const n = names(ctx.leanTools(all(), s));
  assert.ok(n.includes('opt_study_create') && n.includes('foam_stl_generate'));
  const used = { messages: [{ role: 'user', content: '算个圆柱' }, { role: 'assistant', tool_calls: [{ function: { name: 'opt_status' } }] }] };
  assert.ok(names(ctx.leanTools(all(), used)).includes('opt_status'));
});

test('LEAN_TOOLS=0 disables trimming', () => {
  process.env.LEAN_TOOLS = '0';
  try { assert.equal(ctx.leanTools(all(), { messages: [] }).length, all().length); } finally { delete process.env.LEAN_TOOLS; }
});
