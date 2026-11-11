// 偏离登记解析 / 改写 + 审批卡片的服务端逻辑 + 保真度门对登记状态的判断
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dev-'));
process.env.NF_LESSON_FILE = path.join(tmp, 'lessons.jsonl');
const D = await import('../deviations.js');
const F = await import('../fidelity.js');

// caseA_r2 的登记原样（智能体实际写出来的格式）
const R2 = [
  '# 偏离 / 补值登记 — caseA_r2（Lu et al. 2016 CES 143:341，3D 全回路）',
  '# 状态：PENDING = 待用户批准；APPROVED = 已批准；INFO = 读图值/原文未给的补值（非简化）',
  '',
  '[DEV-R2-001] APPROVED  恢复系数 e = 0.9（原文 Table 2 出现 e，未给值；用户任务书批准）',
  '',
  '[DEV-R2-002] INFO  分布器读图值（Fig.1 嵌入图 p2_0.png 插图，比例尺 261 mm / 121 px）',
  '  - 板厚 39 mm（±3），进气室高 37 mm（±3）',
  '  - 采用：r = 0.050/0.075/0.100 m，20/30/40 孔，等效孔径 6.15 mm → 开孔率 5.00 %（§2.4 原文 5%）',
  '',
  '[DEV-R2-003] PENDING  孔截面形状：极坐标扇形近似正方形（边长 5.45 mm，与 Ø6.15 mm 圆孔等面积）',
  '  原因：纯 numpy 生成水密 STL；形状差异小于网格分辨率。开孔率、孔数、孔位、板厚不变。',
  '',
  '[DEV-R2-006] PENDING  冷态阶段 inlet2 组分 = CSTR 出口组成（质量流量 27 kg/h 不变）',
  '  原因：历史教训（冷态一直通 MeOH，出口 ηMeOH 被拉低）。',
  '  影响：冷态只用于流体力学；热态 0–100 s 全部按原文。',
  '',
  '[DEV-R2-007] PENDING  反应源区域 reactZone = z > -0.039 m（板孔+板上全部）；进气室与提升管不设反应源',
  '  原因：原文设备进气室无催化剂。',
  '',
  '[INFO-R2-008] 原文 §2.4 气相含惰性 CO2，但 Table 1 未给流量 → 不加 CO2（进料严格按 Table 1）',
  '',
].join('\n');
const REPRO = '从零复现 Smith et al. (2020) 论文的中试 FCC 鼓泡床 3D 全回路 CFD，必须 3D 按原文';

function workspace(log) {
  const root = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('cases/r2/deviations.log.md', log);
  put('cases/r2/figs/p2_0.png', 'png');
  put('cases/r2/mesh_slice.png', 'png');
  put('cases/r2/notes.txt', 'x');
  return { root, caseDir: path.join(root, 'cases', 'r2'), put, log: () => fs.readFileSync(path.join(root, 'cases', 'r2', 'deviations.log.md'), 'utf8') };
}
const newTask = () => ({ id: 't1', taskText: REPRO, fidelity: { holds: [], userAckAt: 0, approved: [], taskText: REPRO } });

test('parseLog reads the format the agent writes: ids, status words, bodies', () => {
  const e = D.parseLog(R2);
  assert.deepEqual(e.map(x => x.id), ['DEV-R2-001', 'DEV-R2-002', 'DEV-R2-003', 'DEV-R2-006', 'DEV-R2-007', 'INFO-R2-008']);
  assert.deepEqual(e.map(x => x.status), ['approved', 'info', 'pending', 'pending', 'pending', 'info']);
  assert.equal(e[2].title, '孔截面形状：极坐标扇形近似正方形（边长 5.45 mm，与 Ø6.15 mm 圆孔等面积）');
  assert.match(e[2].detail, /^原因：纯 numpy/);
  assert.equal(e[3].detail.split('\n').length, 2);
  assert.deepEqual(e[1].refs, ['p2_0.png']);
});

test('older formats still parse; headings, links and checkboxes are not entries', () => {
  const e = D.parseLog('# 偏离\n[DEV-001] 2026-05-17T14:23 inlet.U: (1.5 0 0) → (1.2 0 0)\n  reason: CFL\n  user_approved: yes\n\n[G1] 主体尺寸按 Fig. 2\n[DEV-S01] 维度：原文 3D → 2D 轴对称 wedge\n## 备注\n[TODO] 之后再看\n[x] 完成\n[文档](http://a/b)\n[DEV-REBUILD-01] 曳力模型：EMMSscale → Gidaspow\n  user_approved: no\n');
  assert.deepEqual(e.map(x => x.id + ':' + x.status), ['DEV-001:approved', 'G1:unmarked', 'DEV-S01:unmarked', 'DEV-REBUILD-01:rejected']);
  assert.equal(e[2].end - e[2].line, 1, 'a markdown heading ends the entry');
  assert.deepEqual(D.parseLog('').length, 0);
});

test('applyDecisions rewrites only the status word and appends an audit trail', () => {
  const now = new Date(2026, 10, 11, 9, 5);
  const out = D.applyDecisions(R2, [
    { id: 'DEV-R2-003', decision: 'approve', note: '' },
    { id: 'DEV-R2-007', decision: 'modify', note: '提升管里\n也要有反应源' },
    { id: 'DEV-R2-999', decision: 'approve' },
    { id: 'DEV-R2-006', decision: 'maybe' },
  ], { now });
  assert.deepEqual(out.applied, ['DEV-R2-003', 'DEV-R2-007']);
  assert.deepEqual(out.missing, ['DEV-R2-999', 'DEV-R2-006']);
  const e = D.parseLog(out.text);
  assert.deepEqual(e.map(x => x.status), ['approved', 'info', 'approved', 'pending', 'revise', 'info']);
  assert.match(e[2].decision, /^APPROVED 2026-11-11T09:05[+-]\d\d:\d\d 审批卡片$/);
  assert.equal(e[4].userNote, '提升管里 也要有反应源');
  const before = D.parseLog(R2);
  for (const i of [0, 1, 2, 3, 4, 5]) {
    assert.equal(e[i].title, before[i].title);
    assert.equal(e[i].detail, before[i].detail, 'machine lines stay out of the shown detail');
    assert.equal(D.sigOf(e[i]), D.sigOf(before[i]), 'a decision does not change the content fingerprint');
  }
  const untouched = l => l.filter(x => !/user_decision|user_note|^\[DEV-R2-00[37]\]/.test(x));
  assert.deepEqual(untouched(out.text.split('\n')), untouched(R2.split('\n')));
  // 再决定一次：状态覆盖，历次记录都保留
  const again = D.applyDecisions(out.text, [{ id: 'DEV-R2-007', decision: 'approve' }], { now });
  const e7 = D.parseLog(again.text)[4];
  assert.equal(e7.status, 'approved');
  assert.equal((again.text.match(/user_decision:/g) || []).length, 3);
  assert.equal(D.applyDecisions(R2.replace(/\n/g, '\r\n'), [{ id: 'DEV-R2-003', decision: 'reject' }]).text.includes('\r\n[DEV-R2-003] REJECTED '), true);
});

test('gate: explicit PENDING blocks until the card approves it', async () => {
  const w = workspace(R2);
  const task = newTask();
  const s = { task };
  const added = await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(added.sort(), ['DEV-R2-003:approval', 'DEV-R2-006:approval', 'DEV-R2-007:approval']);
  assert.match(F.gateMessage(s, '启动求解器'), /DEV-R2-007/);
  const v = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  assert.equal(v.waiting, 3);
  assert.equal(v.file, 'cases/r2/deviations.log.md');
  const pick = (id, decision, note) => ({ id, decision, note, sig: v.entries.find(e => e.id === id).sig });
  const r = await F.decideDeviations({ task, workspace: w.root, caseDir: w.caseDir, decisions: [pick('DEV-R2-007', 'modify', '先说明提升管里为什么可以不设'), pick('DEV-R2-003', 'approve'), pick('DEV-R2-006', 'approve')] });
  assert.equal(r.ok, true);
  assert.match(r.message, /- DEV-R2-003 批准\n- DEV-R2-006 批准\n- DEV-R2-007 要求修改/, 'listed in register order');
  assert.deepEqual(r.open, [{ id: 'DEV-R2-007', status: 'revise' }]);
  assert.match(r.message, /^偏离审批/);
  assert.match(r.message, /DEV-R2-007 要求修改：先说明/);
  assert.match(r.message, /不要启动求解器/);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-007:approval'], 'approved ones are released at once');
  assert.match(w.log(), /\[DEV-R2-003\] APPROVED  ?孔截面形状/);
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-007:approval']);
  // 卡片汇总消息里有「批准」二字，但不能把没批的那条也放行
  await F.onUserMessage(s, r.message);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-007:approval']);
  const v2 = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  const r2 = await F.decideDeviations({ task, workspace: w.root, caseDir: w.caseDir, decisions: [{ id: 'DEV-R2-007', decision: 'approve', sig: v2.entries.find(e => e.id === 'DEV-R2-007').sig }] });
  assert.deepEqual(r2.open, []);
  assert.match(r2.message, /已经没有待批的偏离/);
  await F.scanCase(s, w.caseDir, REPRO);
  assert.equal(F.gateMessage(s, 'x'), '');
  assert.equal(task.fidelity.decisions['DEV-R2-007'].decision, 'approve');
  assert.match(task.fidelity.decisions['DEV-R2-003'].text, /^孔截面形状/);
});

test('gate: the agent cannot approve its own pending deviation when the user never answered', async () => {
  const w = workspace(R2);
  const task = newTask();
  const s = { task };
  assert.deepEqual(await F.noteCase(s, w.caseDir), ['DEV-R2-003', 'DEV-R2-006', 'DEV-R2-007']);
  // 提问超时后智能体自己把三条都改成 APPROVED
  w.put('cases/r2/deviations.log.md', R2.replace(/\] PENDING /g, '] APPROVED '));
  const added = await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(added.sort(), ['DEV-R2-003:selfapproved', 'DEV-R2-006:selfapproved', 'DEV-R2-007:selfapproved']);
  assert.match(F.gateMessage(s, '启动求解器'), /没有用户批准的记录/);
  const v = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  assert.equal(v.waiting, 3);
  assert.equal(v.entries.find(e => e.id === 'DEV-R2-003').unbacked, true);
  assert.equal(v.entries.find(e => e.id === 'DEV-R2-001').needsUser, false, 'approved before any question: left alone');
  // 「继续」按钮发出的固定文本不算用户回话
  await F.onUserMessage(s, '继续推进未完成的工作');
  await F.scanCase(s, w.caseDir, REPRO);
  assert.equal(F.holds(s).length, 3);
});

test('gate: approval given in chat after the question is accepted; a later re-pend needs a new one', async () => {
  const w = workspace(R2);
  const task = newTask();
  const s = { task };
  await F.noteCase(s, w.caseDir);
  await new Promise(r => setTimeout(r, 5));
  await F.onUserMessage(s, '全部 OK，三项偏离都批准，启动冷态');
  w.put('cases/r2/deviations.log.md', R2.replace(/\] PENDING /g, '] APPROVED '));
  assert.deepEqual(await F.scanCase(s, w.caseDir, REPRO), []);
  assert.equal(F.gateMessage(s, 'x'), '');
  // 之后智能体把 003 改写并重新申报，再自行批准：要新的依据
  await new Promise(r => setTimeout(r, 5));
  w.put('cases/r2/deviations.log.md', w.log().replace('[DEV-R2-003] APPROVED ', '[DEV-R2-003] PENDING '));
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-003:approval']);
  w.put('cases/r2/deviations.log.md', w.log().replace('[DEV-R2-003] PENDING ', '[DEV-R2-003] APPROVED '));
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-003:selfapproved']);
});

test('gate: a card approval is void once the entry title is rewritten; fixing or withdrawing releases', async () => {
  const w = workspace(R2);
  const task = newTask();
  const s = { task };
  const v = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  const sig = id => v.entries.find(e => e.id === id).sig;
  await F.decideDeviations({ task, workspace: w.root, caseDir: w.caseDir, decisions: ['DEV-R2-003', 'DEV-R2-006'].map(id => ({ id, decision: 'approve', sig: sig(id) })).concat([{ id: 'DEV-R2-007', decision: 'reject', sig: sig('DEV-R2-007') }]) });
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-007:approval']);
  assert.match(F.holds(s)[0].label, /用户未批准/);
  // 智能体把被拒的那条直接改成 APPROVED：不放行
  w.put('cases/r2/deviations.log.md', w.log().replace('[DEV-R2-007] REJECTED ', '[DEV-R2-007] APPROVED '));
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-007:selfapproved']);
  // 改回按原文做并撤回：放行
  w.put('cases/r2/deviations.log.md', w.log().replace('[DEV-R2-007] APPROVED ', '[DEV-R2-007] WITHDRAWN 已按原文实现；原方案：'));
  await F.scanCase(s, w.caseDir, REPRO);
  assert.equal(F.gateMessage(s, 'x'), '');
  // 已批准的 003 标题被换成另一件事：批准作废
  w.put('cases/r2/deviations.log.md', w.log().replace('孔截面形状：极坐标扇形近似正方形', '不建分布板，底部均匀进气'));
  await F.scanCase(s, w.caseDir, REPRO);
  assert.deepEqual(F.holds(s).map(h => h.key), ['DEV-R2-003:selfapproved']);
  const v2 = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  const e3 = v2.entries.find(e => e.id === 'DEV-R2-003');
  assert.equal(e3.needsUser && e3.decided.changed, true);
});

test('decide: stale content, missing note, unknown ids and duplicates are refused without writing', async () => {
  const w = workspace(R2);
  const task = newTask();
  const v = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  const sig = v.entries.find(e => e.id === 'DEV-R2-003').sig;
  const go = decisions => F.decideDeviations({ task, workspace: w.root, caseDir: w.caseDir, decisions });
  assert.equal((await go([{ id: 'DEV-R2-003', decision: 'modify', note: '  ', sig }])).status, 400);
  assert.equal((await go([{ id: 'DEV-R2-404', decision: 'approve', sig }])).status, 400);
  assert.equal((await go([{ id: 'DEV-R2-003', decision: 'approve', sig }, { id: 'DEV-R2-003', decision: 'reject', sig }])).status, 400);
  assert.equal((await go([])).status, 400);
  assert.equal((await go('nope')).status, 400);
  w.put('cases/r2/deviations.log.md', R2.replace('边长 5.45 mm', '边长 9 mm'));
  const stale = await go([{ id: 'DEV-R2-003', decision: 'approve', sig }]);
  assert.equal(stale.status, 409);
  assert.equal(stale.stale, 'DEV-R2-003');
  assert.equal(w.log().includes('user_decision'), false);
  assert.equal(task.fidelity.decisions, undefined);
  assert.equal((await F.decideDeviations({ task, workspace: w.root, caseDir: path.join(w.root, 'cases', 'none'), decisions: [] })).status, 404);
  assert.equal((await F.deviationView({ task, workspace: w.root, caseDir: '' })).data.entries.length, 0);
});

test('evidence: images named in an entry resolve inside the case; case images are the fallback', async () => {
  const w = workspace(R2 + '\n[DEV-R2-009] PENDING 入口 3 形状\n  evidence: figs/p2_0.png, ../../../etc/passwd.png, notes.txt\n');
  const task = newTask();
  const v = (await F.deviationView({ task, workspace: w.root, caseDir: w.caseDir })).data;
  assert.deepEqual(v.entries.find(e => e.id === 'DEV-R2-009').evidence.map(x => x.path), ['cases/r2/figs/p2_0.png']);
  assert.deepEqual(v.entries.find(e => e.id === 'DEV-R2-002').evidence.map(x => x.path), ['cases/r2/figs/p2_0.png']);
  assert.deepEqual(v.entries.find(e => e.id === 'DEV-R2-003').evidence, []);
  assert.deepEqual(v.caseImages.map(x => x.path), ['cases/r2/mesh_slice.png']);
  assert.equal(v.entries.find(e => e.id === 'DEV-R2-009').detail, '', 'the evidence line is not shown as text');
});

test('gate: unmarked old-style entries are still judged by the major-deviation rules; non-repro tasks are not gated', async () => {
  const w = workspace('[DEV-S01] 维度：原文 3D → 2D 轴对称 wedge\n[DEV-S07] 气体粘度 2.67e-05 Pa·s\n[G9] ① 进气管（水平管）未建\n');
  const s = { task: newTask() };
  assert.deepEqual(await F.scanCase(s, w.caseDir, REPRO), ['DEV-S01:dimension']);
  const plain = { id: 't2', taskText: '帮我跑个 cavity', fidelity: { holds: [], userAckAt: 0, approved: [], taskText: '' } };
  const v = (await F.deviationView({ task: plain, workspace: w.root, caseDir: w.caseDir })).data;
  assert.equal(v.gated, false);
  assert.equal(v.waiting, 0);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
