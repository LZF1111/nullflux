// node test/evolve.test.mjs —— 垂直 playbook 沉淀/实例化/注入单测
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf_evo_'));
process.env.NF_VERTICAL_DIR = path.join(tmp, 'verticals');
const E = await import('../evolve.js');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };
const mk = (rel, txt = 'x') => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

mk('ws/cases/caseA/system/controlDict', 'application reactingTwoPhaseEulerFoam;');
mk('ws/cases/caseA/0.orig/U.gas', 'U');
mk('ws/cases/caseA/constant/phaseProperties', 'drag EMMSbubbling;');
mk('ws/cases/caseA/constant/polyMesh/points', 'big');
mk('ws/cases/caseA/12.5/U.gas', 'result');
mk('ws/cases/caseA/processor0/0/U.gas', 'p');
mk('ws/cases/caseA/log.reactingTwoPhaseEulerFoam', 'log');
mk('ws/cases/caseA/genGeom.py', 'print(1)');
mk('ws/src/EMMSbubbling/EMMSbubbling.C', 'code');
mk('ws/src/EMMSbubbling/Make/linux64GccDPInt32Opt/x.o', 'obj');

function runSession() {
  const s = { task: {} };
  E.onLlmStep(s); E.onLlmStep(s); E.onLlmStep(s);
  E.onTool(s, 'write_file', { path: 'cases/caseA/genGeom.py' }, '已写入');
  E.onTool(s, 'run_command', { command: 'blockMesh' }, '--> FOAM FATAL ERROR: bad hex');
  E.onTool(s, 'run_stage_done', { stage: 'mesh', memo: '35万单元 checkMesh OK' }, 'ok');
  E.onTool(s, 'run_command', { command: 'mpirun' }, 'End');
  E.onTool(s, 'run_stage_done', { stage: 'cold', memo: '压降=床重/截面' }, 'ok');
  return s;
}

await t('轨迹按阶段记录工具/文件/报错', async () => {
  const s = runSession();
  const m = E.metricsOf(s);
  assert.equal(m.llmSteps, 3); assert.equal(m.errors, 1); assert.equal(m.stages, 2);
  assert.ok(E.isEvolvable(s));
  assert.deepEqual(s.task.evo.stages[0].files, ['cases/caseA/genGeom.py']);
  assert.match(s.task.evo.stages[0].errors[0], /FOAM FATAL/);
});

await t('distill 只拷模板（跳过结果/processor/日志/polyMesh/编译产物）', async () => {
  const s = runSession();
  const summarize = async (st) => JSON.stringify(st.map(x => ({ recipe: 'R-' + x.name, pitfall: '' })));
  const r = await E.distill(s, { id: 'fb-demo', title: '鼓泡流化床', triggers: ['FCC', '鼓泡床', '流化床', 'EMMS'], case_path: path.join(tmp, 'ws/cases/caseA'), extra_paths: [path.join(tmp, 'ws/src/EMMSbubbling')], benchmarks: { 'C2H4/C3H6': 1.2449 } }, summarize);
  assert.ok(r.ok, r.error); assert.equal(r.version, 1);
  const c = path.join(r.dir, 'case');
  assert.ok(fs.existsSync(path.join(c, 'system/controlDict')));
  assert.ok(fs.existsSync(path.join(c, 'genGeom.py')));
  for (const bad of ['12.5', 'processor0', 'log.reactingTwoPhaseEulerFoam', 'constant/polyMesh']) assert.ok(!fs.existsSync(path.join(c, bad)), bad);
  assert.ok(fs.existsSync(path.join(r.dir, 'extra/EMMSbubbling/EMMSbubbling.C')));
  assert.ok(!fs.existsSync(path.join(r.dir, 'extra/EMMSbubbling/Make/linux64GccDPInt32Opt')));
  const pb = await E.loadPlaybook('fb-demo');
  assert.equal(pb.stages[0].recipe, 'R-mesh');
});

await t('再次 distill → 版本升级，历次效率累积', async () => {
  const s = runSession();
  const r = await E.distill(s, { id: 'fb-demo', triggers: ['催化裂化'], case_path: path.join(tmp, 'ws/cases/caseA') });
  assert.equal(r.version, 2);
  const pb = await E.loadPlaybook('fb-demo');
  assert.equal(pb.runs.length, 2); assert.ok(pb.triggers.includes('催化裂化') && pb.triggers.includes('fcc'));
  assert.equal(pb.benchmarks['C2H4/C3H6'], 1.2449);
});

await t('injectionFor：命中≥2 触发词才注入', async () => {
  assert.match(E.injectionFor('帮我模拟一个 FCC 流化床反应器'), /vertical_instantiate/);
  assert.equal(E.injectionFor('模拟 FCC'), '');
  assert.equal(E.injectionFor('跑个圆柱绕流'), '');
});

await t('instantiate：拷模板+附带目录，目标非空拒绝', async () => {
  const dest = path.join(tmp, 'ws2/cases/caseB');
  const r = await E.instantiate('fb-demo', dest);
  assert.ok(r.ok, r.error);
  assert.ok(fs.existsSync(path.join(dest, 'constant/phaseProperties')));
  assert.ok(fs.existsSync(path.join(tmp, 'ws2/cases/EMMSbubbling/EMMSbubbling.C')));
  assert.equal((await E.instantiate('fb-demo', dest)).ok, false);
});

await t('未验证阶段不足 → 不可沉淀', async () => {
  const s = { task: {} };
  E.onTool(s, 'run_stage_done', { stage: 'x', passed: false }, '');
  assert.equal(E.isEvolvable(s), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/6 passed`);
