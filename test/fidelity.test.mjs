// node test/fidelity.test.mjs —— 保真度门 + 教训库单测
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf_fid_'));
process.env.NF_LESSON_FILE = path.join(tmp, 'lessons.jsonl');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'lessons.jsonl'), process.env.NF_LESSON_FILE);
const F = await import('../fidelity.js');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('PASS', name); };
const mk = (rel, txt) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

const REPRO = '复现论文 Smith 2020 中试 FCC 反应器（必须 3D 按原文）';
mk('case/constant/polyMesh/boundary', 'inlet { type patch; }\nback { type wedge; }\nfront { type wedge; }\n');
mk('deviations.log.md', '# 偏离\n\n[DEV-001] 维度：原文 3D → 2D 轴对称 wedge\n  reason: 算力\n\n[DEV-003] 分布板：原文多孔板 → 本复现不建分布器，底部均匀进气\n\n[DEV-005] 恢复系数 e 取 0.9\n');

await t('parseDeviations 识别重大偏离', async () => {
  const d = F.parseDeviations(fs.readFileSync(path.join(tmp, 'deviations.log.md'), 'utf8'));
  assert.equal(d.length, 3);
  assert.ok(d[0].majors.includes('dimension'));
  assert.ok(d[1].majors.includes('geometry') && d[1].majors.includes('bc'));
  assert.deepEqual(d[2].majors, []);
});

await t('复现任务：wedge 网格 + 未批准偏离 → 拦截', async () => {
  const s = { task: {} };
  await F.onUserMessage(s, REPRO);
  const added = await F.scanCase(s, path.join(tmp, 'case'), REPRO);
  assert.ok(added.includes('dimension'));
  assert.ok(added.some(k => k.startsWith('DEV-003')));
  assert.match(F.gateMessage(s, '启动求解器'), /保真度门/);
});

await t('后续轮次用原任务文本判定（不受短消息影响）', async () => {
  const s = { task: {} };
  await F.onUserMessage(s, REPRO);
  await F.scanCase(s, path.join(tmp, 'case'), '继续');
  assert.ok(F.holds(s).length >= 2);
});

await t('用户批准 → 放行且不再重复拦截', async () => {
  const s = { task: {} };
  await F.onUserMessage(s, REPRO);
  await F.scanCase(s, path.join(tmp, 'case'), REPRO);
  await F.onUserMessage(s, '批准这些偏离');
  assert.equal(F.gateMessage(s, 'x'), '');
  await F.scanCase(s, path.join(tmp, 'case'), REPRO);
  assert.equal(F.holds(s).length, 0);
});

await t('拒绝语气不算批准', async () => {
  const s = { task: {} };
  await F.onUserMessage(s, REPRO);
  await F.scanCase(s, path.join(tmp, 'case'), REPRO);
  await F.onUserMessage(s, '不同意，必须按原文 3D');
  assert.ok(F.holds(s).length > 0);
});

await t('任务明确允许 2D → 维度不拦，删分布器仍拦', async () => {
  const s = { task: {} };
  const txt = '复现论文，2D 轴对称或 3D 均可';
  await F.onUserMessage(s, txt);
  const added = await F.scanCase(s, path.join(tmp, 'case'), txt);
  assert.ok(!added.includes('dimension'));
  assert.ok(added.some(k => k.startsWith('DEV-003')));
});

await t('原题就是二维文献基准（未提 3D）→ empty patch 不算降维', async () => {
  const s = { task: {} };
  const txt = '完成文献基准算例：二维单气泡上升（Hysing et al. 2009 test case 1），二维（厚度方向 1 个单元）';
  await F.onUserMessage(s, txt);
  const added = await F.scanCase(s, path.join(tmp, 'case'), txt);
  assert.ok(!added.includes('dimension'));
  assert.ok(!added.some(k => k.endsWith(':dimension')));
});

await t('非复现任务不拦', async () => {
  const s = { task: {} };
  await F.onUserMessage(s, '帮我跑个 cavity');
  assert.deepEqual(await F.scanCase(s, path.join(tmp, 'case'), '帮我跑个 cavity'), []);
});

await t('lessonsFor 按触发词注入规则', async () => {
  assert.match(F.lessonsFor('复现这篇论文的流化床'), /历史事故教训/);
  assert.equal(F.lessonsFor('画个图'), '');
});

await t('autoLearnErrors 只收能匹配原报错的正则', async () => {
  const saved = [];
  const add = async (p) => { saved.push(p); return { ok: true }; };
  const err = '--> FOAM FATAL IO ERROR: Block hex (0 1 2 0 3 4 5 3) grading has inward-pointing faces';
  const good = async () => '{"pattern":"inward-pointing faces","category":"blockMesh 顶点顺序","causes":["顶点逆序"],"steps":["调整 hex 顶点顺序"]}';
  const bad = async () => '{"pattern":"no such text","category":"x"}';
  assert.deepEqual(await F.autoLearnErrors([err], '', bad, add), []);
  assert.deepEqual(await F.autoLearnErrors([err], '', good, add), ['blockMesh 顶点顺序']);
  assert.equal(saved.length, 1);
});

await t('autoLearnErrors 过滤 gdb/MPI 噪声与过宽正则', async () => {
  const saved = [];
  const add = async (p) => { saved.push(p); return { ok: true }; };
  const gdb = '[New Thread 0x7f12 (LWP 1)]\n#0  0x00007f1 in ?? ()\n#1  0x00007f2 in ?? ()\n(gdb) bt\nReading symbols from x\n[node1:123] MPI_ABORT was invoked\nsigFpe';
  const llm = async () => '{"pattern":"Thread","category":"MPI并行挂起"}';
  assert.deepEqual(await F.autoLearnErrors([gdb], '', llm, add), []);
  const err = '--> FOAM FATAL ERROR: Maximum number of iterations exceeded in kineticTheory';
  const wide = async () => '{"pattern":"Time","category":"x"}';
  assert.deepEqual(await F.autoLearnErrors([err], '', wide, add), []);
  assert.equal(saved.length, 0);
  assert.ok(!/Thread|0x/.test(F.cleanErrorText(gdb).text));
});

await t('重力方向与立式几何最长轴不一致 → 拦截', async () => {
  const cm = 'Overall domain bounding box (-0.295 -0.295 -3.35) (0.295 0.295 2.897)';
  assert.match(F.gravityWarning('value (0 -9.81 0);', '', cm), /最长轴是 z/);
  assert.equal(F.gravityWarning('value (0 0 -9.81);', '', cm), '');
  assert.equal(F.gravityWarning('value (0 -9.81 0);', '', 'bounding box (0 0 0) (1 1 1.2)'), '');
  mk('gcase/constant/g', 'dimensions [0 1 -2 0 0 0 0];\nvalue (0 -9.81 0);\n');
  mk('gcase/log.checkMesh', cm + '\nMesh OK.\n');
  const s = { task: {} };
  await F.onUserMessage(s, REPRO);
  assert.ok((await F.scanCase(s, path.join(tmp, 'gcase'), REPRO)).includes('gravity'));
});

await t('kpiCredibility：窗口未过 n·τ / 初值主导 → 不通过；准稳态 + 有流场证据 → 通过', async () => {
  const kpis = [{ name: 'wc', this: 5.651, paper: 5.655, init: 5.662 }, { name: 'etaMeOH', this: 97.6, paper: 99.97 }];
  const early = F.kpiCredibility({ t_react_start: 19.62, t_window: [19.7, 20.9], tau: 20, kpis, outlet_min_flux: 1e-18 });
  assert.equal(early.passed, false);
  assert.ok(early.issues.some(s => /准稳态/.test(s)) && early.issues.some(s => /统计不足/.test(s)) && early.issues.some(s => /尚未到达/.test(s)));
  assert.deepEqual(early.evidence, ['etaMeOH']);
  const ok = F.kpiCredibility({ t_react_start: 19.62, t_window: [79.6, 119.6], tau: 20, kpis });
  assert.equal(ok.passed, true);
  const onlyInit = F.kpiCredibility({ t_react_start: 0, t_window: [60, 100], tau: 20, kpis: [kpis[0]] });
  assert.equal(onlyInit.passed, false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/12 passed`);
