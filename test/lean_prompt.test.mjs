import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const ctx = vm.createContext({ process, SETTINGS: {} });
vm.runInContext(grab('const SYSTEM_PROMPT_BASE', '\n// SIM_PROMPT removed').replace(/^const /, 'var '), ctx);
vm.runInContext(grab('const FOAM_PROMPT = `', '\nconst ').replace(/^const /, 'var ') + '\n' + grab('function _splitPromptSections', 'const MFIX_PROMPT').replace(/^const /gm, 'var '), ctx);
vm.runInContext(grab('const V9_PROMPT_BLOCK', '\nfunction buildSystemPrompt').replace(/^const /gm, 'var '), ctx);
vm.runInContext(grab('function _firstJsonObject', '\n// 4) 通用视觉 Verifier'), ctx);

const plain = '二维鼓泡流化床，twoPhaseEulerFoam 算到 6 s，求压降';
const paper = '复现论文 Smith 2020 的 FCC 曳力模型';

test('lean base prompt is much shorter and keeps core rules', () => {
  const full = ctx.SYSTEM_PROMPT_BASE('/w');
  const lean = ctx.leanSystemBase(full, plain);
  assert.ok(lean.length < full.length / 3);
  for (const k of ['run_command', 'vision_analyze', 'task_complete', 'foam_mesh_verify', 'WATCHDOG_HALT', 'solver_wait']) assert.ok(lean.includes(k), k);
  assert.ok(!lean.includes('# 文献工作流'));
  assert.ok(ctx.leanSystemBase(full, paper).includes('# 文献工作流'));
});

test('lean foam prompt drops the interactive 5-step flow but keeps paper rules for paper tasks', () => {
  const lean = ctx.foamPromptFor(plain, { hadError: false });
  assert.ok(!lean.includes('第 1 步 · 问意图'));
  assert.ok(lean.includes('adjustTimeStep'));
  assert.ok(ctx.foamPromptFor(paper, { hadError: false }).includes('反漂移协议'));
});

test('V9 and skill blocks are trimmed unless the task needs them', () => {
  assert.ok(ctx.leanV9Block(plain).length < ctx.V9_PROMPT_BLOCK.length / 2);
  assert.ok(ctx.leanV9Block(paper).includes('算法植入四步法'));
  assert.ok(ctx.leanSkillBlock('做一次技能 A/B 评测').includes('skill_eval_compare'));
});

test('LEAN_PROMPT=0 restores the full prompt', () => {
  process.env.LEAN_PROMPT = '0';
  try {
    const full = ctx.SYSTEM_PROMPT_BASE('/w');
    assert.equal(ctx.leanSystemBase(full, plain), full);
    assert.equal(ctx.leanV9Block(plain), ctx.V9_PROMPT_BLOCK);
  } finally { delete process.env.LEAN_PROMPT; }
});

test('VLM JSON is found even after a header with brackets', () => {
  const m = ctx._firstJsonObject('[vision_analyze · 1 张图 · detail=high]\n\n{"passed": true, "score": 88, "reasons": ["[图1] ok {x}"]}\n说明');
  assert.equal(JSON.parse(m[0]).score, 88);
  assert.equal(ctx._firstJsonObject('no json here'), null);
});
