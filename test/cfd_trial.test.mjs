import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCfdTrial, verifyTrialEvidence } from '../cfd_trial.js';

const fixture = `
const fs = require('node:fs');
const path = require('node:path');
const stage = process.argv[1];
const mode = process.argv[2];
if (stage !== 'verify') fs.appendFileSync('order.txt', stage + '\\n');
if (stage === 'generate') {
  const params = JSON.parse(fs.readFileSync(process.env.CFD_PARAMS_PATH, 'utf8'));
  if (params.holes !== 12) process.exit(8);
  fs.writeFileSync('geometry.txt', 'generated:' + params.holes);
  if (mode === 'generate-fail') process.exit(9);
  if (mode === 'timeout') setInterval(() => {}, 1000);
}
if (stage === 'mesh') {
  if (mode === 'long-log') for (let index = 0; index < 5000; index++) console.log('mesh progress ' + index);
  // 像 24 核分解的多组分 3D 算例：processor*/0 下几万个场文件
  if (mode === 'many-files') for (let p = 0; p < 24; p++) {
    fs.mkdirSync('processor' + p + '/0', {recursive:true});
    for (let i = 0; i < 1100; i++) fs.writeFileSync('processor' + p + '/0/field_with_a_rather_long_species_and_phase_name_' + i + '.gas', String(i));
  }
  fs.mkdirSync('constant/polyMesh', {recursive:true});
  for (const name of ['points','faces','owner','neighbour','boundary']) fs.writeFileSync(path.join('constant/polyMesh',name), name);
  if (mode !== 'mesh-fake') console.log('Mesh OK.');
  if (mode === 'mesh-failed') console.error('Failed 2 mesh checks.');
  if (mode === 'mesh-fatal') console.error('FOAM FATAL ERROR');
}
if (stage === 'solve') {
  console.log('Time = ' + (mode === 'short' ? 4 : 10));
  if (mode !== 'no-end') console.log('End');
  if (mode === 'fatal') console.error('FOAM FATAL ERROR');
  if (mode === 'sigfpe') console.error('#0  Foam::sigFpe::sigHandler(int) at ??:?');
  if (mode === 'fpe-banner') console.log('trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).');
  if (mode === 'mpi') console.error('MPI_ABORT');
}
if (stage === 'verify') {
  const metrics = {loss:0.2, holdoutError:0.3, windowCoverage:1, sampleCount:100};
  if (mode === 'holdout-missing') delete metrics.holdoutError;
  if (mode === 'holdout-bad') metrics.holdoutError = 5;
  if (mode === 'bad-window') metrics.windowCoverage = 0.1;
  if (mode === 'bad-timing') metrics.sampleCount = 1;
  if (mode === 'script-passed') metrics.passed = true;
  if (mode === 'infinite') metrics.loss = null;
  fs.writeFileSync(process.env.CFD_METRICS_PATH, JSON.stringify(metrics));
  if (mode === 'change-mesh') fs.appendFileSync('constant/polyMesh/points','changed');
  if (mode === 'change-config') fs.appendFileSync('trial-config.json',' ');
  if (mode === 'extra-output') fs.writeFileSync('extra.txt','forbidden');
  if (mode === 'change-log') fs.appendFileSync('logs/mesh.stdout.log','changed');
  if (mode === 'special-output') fs.writeFileSync('__proto__','forbidden');
  if (mode === 'symlink-output') fs.symlinkSync('geometry.txt','linked.txt');
}
`;

async function setup(context, mode = 'success') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfd-trial-'));
  context.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const baseCase = path.join(root, 'template');
  for (const directory of ['system', 'constant', '0', '100', 'postProcessing']) {
    await fs.mkdir(path.join(baseCase, directory), { recursive: true });
    await fs.writeFile(path.join(baseCase, directory, 'input'), directory);
  }
  await fs.writeFile(path.join(baseCase, 'old.log'), 'stale');
  const config = {
    baseCase, trialDir: path.join(root, 'candidate'), studyId: 'study-1', trialId: 'trial-1', params: { holes: 12 },
    stages: Object.fromEntries(['generate', 'mesh', 'solve', 'verify'].map(stage => [stage, {
      command: [process.execPath, '-e', fixture, stage, mode], timeoutMs: 10000,
    }])),
    acceptance: {
      endTime: 10, objective: 'loss',
      metrics: [
        { name: 'loss', max: 1, role: 'fit' },
        { name: 'holdoutError', max: 1, role: 'holdout' },
        { name: 'windowCoverage', min: 0.99, role: 'holdout' },
        { name: 'sampleCount', min: 10, role: 'fit' },
      ],
      measurement: { windowStart: 5, windowEnd: 10, description: 'Fixture measurements over [5,10]; timing counts samples.', windowMetric: 'windowCoverage', timingMetric: 'sampleCount' },
    },
  };
  const evidence = value => ({ resultPath: path.join(config.trialDir, 'trial-result.json'), studyId: config.studyId, trialId: config.trialId, value });
  return { root, config, evidence };
}

test('success: actual commands, order, params, clean template, hashes, independent evidence', async context => {
  const { config, evidence } = await setup(context);
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
  assert.equal(result.value, 0.2);
  assert.equal(await fs.readFile(path.join(config.trialDir, 'order.txt'), 'utf8'), 'generate\nmesh\nsolve\n');
  assert.deepEqual(result.stages.map(stage => stage.name), ['generate', 'mesh', 'solve', 'verify']);
  assert.equal(await fs.readFile(path.join(config.trialDir, 'geometry.txt'), 'utf8'), 'generated:12');
  for (const stale of ['100', 'postProcessing', 'old.log']) await assert.rejects(fs.access(path.join(config.trialDir, stale)));
  assert.match(result.configHash, /^[a-f0-9]{64}$/);
  assert.equal((await verifyTrialEvidence(evidence(0.2))).passed, true);
  await assert.rejects(verifyTrialEvidence({ ...evidence(0.2), trialId: 'wrong' }), /identity/);
  await assert.rejects(verifyTrialEvidence(evidence(NaN)), /finite/);
  await assert.rejects(verifyTrialEvidence(evidence(0.4)), /value/);
});

test('OpenFOAM FOAM_SIGFPE startup banner is not a crash', async context => {
  const { config } = await setup(context, 'fpe-banner');
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
});

for (const [mode, count] of [['generate-fail', 1], ['mesh-fake', 2], ['mesh-failed', 2], ['mesh-fatal', 2], ['short', 3], ['fatal', 3], ['sigfpe', 3], ['mpi', 3], ['no-end', 3]]) {
  test(`reject ${mode}; never execute later stages`, async context => {
    const { config, evidence } = await setup(context, mode);
    const result = await runCfdTrial(config);
    assert.equal(result.passed, false);
    assert.equal(result.value, null);
    assert.equal(result.stages.length, count);
    assert.equal((await fs.readFile(path.join(config.trialDir, 'order.txt'), 'utf8')).trim().split('\n').length, count);
    await assert.rejects(verifyTrialEvidence(evidence(0.2)));
  });
}

for (const mode of ['holdout-missing', 'holdout-bad', 'bad-window', 'bad-timing', 'script-passed', 'infinite', 'change-mesh', 'change-config', 'extra-output', 'change-log', 'special-output']) {
  test(`reject verifier output: ${mode}`, async context => {
    const { config } = await setup(context, mode);
    const result = await runCfdTrial(config);
    assert.equal(result.passed, false);
    assert.equal(result.value, null);
    assert.equal(result.stages.length, 4);
  });
}

test('timeout terminates external stage and records failure', async context => {
  const { config } = await setup(context, 'timeout');
  config.stages.generate.timeoutMs = 500;
  const result = await runCfdTrial(config);
  assert.equal(result.passed, false);
  assert.equal(result.value, null);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].timedOut, true);
});

test('reject existing directory and ancestor/descendant overlap', async context => {
  const { config } = await setup(context);
  await fs.mkdir(config.trialDir);
  await assert.rejects(runCfdTrial(config), /EEXIST/);
  await assert.rejects(runCfdTrial({ ...config, trialDir: config.baseCase }), /overlap/);
  await assert.rejects(runCfdTrial({ ...config, trialDir: path.join(config.baseCase, 'child') }), /overlap/);
  await assert.rejects(runCfdTrial({ ...config, trialDir: path.dirname(config.baseCase) }), /overlap/);
});

test('reject missing holdout, objective, quality, and nonfinite/unbounded timeout before execution', async context => {
  const { config } = await setup(context);
  const invalid = structuredClone(config);
  invalid.acceptance.metrics = invalid.acceptance.metrics.map(metric => ({ ...metric, role: 'fit' }));
  await assert.rejects(runCfdTrial(invalid), /holdout/);
  for (const timeoutMs of [undefined, 0, Infinity, NaN, 1.5, 2147483648]) {
    const bad = structuredClone(config);
    bad.stages.mesh.timeoutMs = timeoutMs;
    await assert.rejects(runCfdTrial(bad));
  }
  const noQuality = structuredClone(config);
  delete noQuality.acceptance.measurement;
  await assert.rejects(runCfdTrial(noQuality), /measurement/);
  const noObjective = structuredClone(config);
  noObjective.acceptance.objective = 'not-present';
  await assert.rejects(runCfdTrial(noObjective), /objective/);
  await assert.rejects(fs.access(config.trialDir));
});

for (const filename of ['metrics.json', 'constant/polyMesh/points', 'logs/mesh.stdout.log', 'trial-config.json', 'trial-params.json', '0/input']) {
  test(`evidence rejects tampered ${filename}`, async context => {
    const { config, evidence } = await setup(context);
    assert.equal((await runCfdTrial(config)).passed, true);
    await fs.appendFile(path.join(config.trialDir, filename), ' ');
    await assert.rejects(verifyTrialEvidence(evidence(0.2)));
  });
}

test('evidence does not trust passed/value/checks: recomputes thresholds and stage states', async context => {
  const { config, evidence } = await setup(context, 'holdout-bad');
  const failed = await runCfdTrial(config);
  assert.equal(failed.passed, false);
  const resultPath = evidence(0.2).resultPath;
  await fs.writeFile(resultPath, JSON.stringify({ ...failed, passed: true, value: 0.2 }));
  await assert.rejects(verifyTrialEvidence(evidence(0.2)), /Acceptance failed/);
  const successful = { ...config, trialDir: `${config.trialDir}-good` };
  for (const spec of Object.values(successful.stages)) spec.command = [...spec.command.slice(0, -1), 'success'];
  const result = await runCfdTrial(successful);
  assert.equal(result.passed, true);
  result.stages[1].exitCode = 2;
  const goodResultPath = path.join(successful.trialDir, 'trial-result.json');
  await fs.writeFile(goodResultPath, JSON.stringify(result));
  await assert.rejects(verifyTrialEvidence({ ...evidence(0.2), resultPath: goodResultPath }), /command failed/);
});

test('symlink template/trial/artifacts are refused', async context => {
  const { root, config, evidence } = await setup(context);
  const link = path.join(root, 'template-link');
  try {
    await fs.symlink(config.baseCase, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') { context.skip('OS denies symlink creation'); return; }
    throw error;
  }
  await assert.rejects(runCfdTrial({ ...config, baseCase: link }), /Symlink/);
  await assert.rejects(runCfdTrial({ ...config, trialDir: path.join(link, 'trial') }), /Symlink/);
  assert.equal((await runCfdTrial(config)).passed, true);
  await fs.symlink(config.baseCase, path.join(config.trialDir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyTrialEvidence(evidence(0.2)), /Symlink/);
});

test('large logs stay on disk; result tails are bounded', async context => {
  const { config, evidence } = await setup(context, 'long-log');
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
  assert.ok((await fs.stat(path.join(config.trialDir, 'logs/mesh.stdout.log'))).size > 16384);
  assert.ok(Buffer.byteLength(result.stages[1].stdoutTail) <= 16384);
  assert.equal((await verifyTrialEvidence(evidence(0.2))).passed, true);
});

test('decomposed 3D case: evidence manifest above 4 MB still verifies', async context => {
  // processor*/ 下 2.6 万个文件 → trial-result.json 里的两份 sha256 清单超过 4 MB（真实对照是 5.9 MB）
  const { config, evidence } = await setup(context, 'many-files');
  for (const s of Object.values(config.stages)) s.timeoutMs = 300000;
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
  const sz = (await fs.stat(evidence(0.2).resultPath)).size; assert.ok(sz > 4 * 1024 * 1024, 'size ' + sz);
  assert.equal((await verifyTrialEvidence(evidence(0.2))).passed, true);
});

test('evidence rejects forged paths and additional unlisted artifacts', async context => {
  const { config, evidence } = await setup(context);
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true);
  result.stages[0].stdout = '../outside.log';
  await fs.writeFile(evidence(0.2).resultPath, JSON.stringify(result));
  await assert.rejects(verifyTrialEvidence(evidence(0.2)), /path mismatch/);
  result.stages[0].stdout = 'logs/generate.stdout.log';
  await fs.writeFile(evidence(0.2).resultPath, JSON.stringify(result));
  await fs.writeFile(path.join(config.trialDir, 'unlisted.txt'), 'new');
  await assert.rejects(verifyTrialEvidence(evidence(0.2)), /Artifacts/);
});

test('record CLI enforces the study contract and suggested parameters', async context => {
  const { config, root } = await setup(context);
  assert.equal((await runCfdTrial(config)).passed, true);
  const studySpec = path.join(root, 'study.json');
  const spec = { study_id: config.studyId, base_case: config.baseCase, pipeline: { stages: config.stages, acceptance: config.acceptance } };
  await fs.writeFile(studySpec, JSON.stringify(spec));
  const cli = ['cfd_trial.js', '--verify', path.join(config.trialDir, 'trial-result.json'), '--study-id', config.studyId, '--trial-id', config.trialId, '--value', '0.2', '--study-spec', studySpec, '--params', JSON.stringify(config.params), '--trial-dir', config.trialDir];
  const run = promisify(execFile);
  const output = await run(process.execPath, cli);
  assert.equal(JSON.parse(output.stdout).passed, true);
  cli[cli.indexOf('--params') + 1] = '{"holes":99}';
  await assert.rejects(run(process.execPath, cli), /Suggested parameters/);
  cli[cli.indexOf('--params') + 1] = JSON.stringify(config.params);
  spec.pipeline.acceptance.endTime = 20;
  await fs.writeFile(studySpec, JSON.stringify(spec));
  await assert.rejects(run(process.execPath, cli), /Acceptance contract/);
});

test('holdout cannot become the optimization objective', async context => {
  const { config } = await setup(context);
  config.acceptance.objective = 'holdoutError';
  await assert.rejects(runCfdTrial(config), /never holdout/);
});

test('baseline mesh is removed before generation', async context => {
  const { config, evidence } = await setup(context);
  await fs.mkdir(path.join(config.baseCase, 'constant/polyMesh'));
  await fs.writeFile(path.join(config.baseCase, 'constant/polyMesh/oldMesh'), 'stale');
  config.stages.generate.command = [process.execPath, '-e', "if(require('node:fs').existsSync('constant/polyMesh'))process.exit(5)"];
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
  await assert.rejects(fs.access(path.join(config.trialDir, 'constant/polyMesh/oldMesh')));
  // 模板里有 polyMesh 时证据也要能独立复核（分布板对照曾因此被误判"证据无效"）
  assert.equal((await verifyTrialEvidence(evidence(0.2))).passed, true);
});

test('template edits outside polyMesh are still caught by evidence', async context => {
  const { config, evidence } = await setup(context);
  const result = await runCfdTrial(config);
  assert.equal(result.passed, true, result.error);
  result.templateInputs['system/input'] = '0'.repeat(64);
  await fs.writeFile(evidence(0.2).resultPath, JSON.stringify(result));
  await assert.rejects(verifyTrialEvidence(evidence(0.2)), /Template input evidence/);
});