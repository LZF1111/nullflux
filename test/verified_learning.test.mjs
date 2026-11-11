import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrajectory, buildSftSample, draftFromTrajectory } from '../skills.js';
import { kpiCredibility } from '../fidelity.js';

let nextId = 0;
function call(name, args = { case_path: '/case/a' }, result = { passed: true }) {
  const id = `call-${nextId++}`;
  return [
    { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
  ];
}
const complete = (case_path = '/case/a') => [
  ...call('foam_solve_verify', { case_path }), ...call('foam_post_verify', { case_path }),
];

test('mesh alone and mesh pass followed by solver failure cannot become learned CFD', () => {
  const mesh = call('foam_mesh_verify');
  assert.equal(analyzeTrajectory(mesh).verified, false);
  const messages = [...mesh, ...call('foam_solve_verify', undefined, { passed: false })];
  const analysis = analyzeTrajectory(messages);
  assert.equal(analysis.verified, false);
  assert.equal(analysis.verificationFailed, true);
  assert.deepEqual(analysis.verifiers, []);
  assert.equal(buildSftSample(messages), null);
  assert.equal(draftFromTrajectory({ messages }), null);
});

for (const name of ['write_file', 'edit_file', 'multi_edit', 'opt_apply_params', 'run_command', 'foam_run_solver_async', 'foam_create_case', 'delete_file', 'apply_patch', 'unknown_tool']) {
  test(`subsequent ${name} invalidates complete validation even without a result`, () => {
    const messages = [...complete(), call(name)[0]];
    assert.equal(analyzeTrajectory(messages).verified, false);
    assert.deepEqual(analyzeTrajectory(messages).verifiers, []);
  });
}

test('failure clears both passes; recovery requires complete fresh verification', () => {
  const messages = [...complete(), ...call('foam_mesh_verify', undefined, { passed: false })];
  assert.equal(analyzeTrajectory(messages).verificationFailed, true);
  assert.equal(analyzeTrajectory([...messages, ...call('foam_post_verify')]).verified, false);
  assert.equal(analyzeTrajectory([...messages, ...complete()]).verified, true);
});

test('explicit same-case final solve and post pass; task completion requires successful tool result', () => {
  const messages = complete();
  const analysis = analyzeTrajectory(messages);
  assert.equal(analysis.verified, true);
  assert.equal(analysis.casePath, '/case/a');
  assert.equal(analysis.taskDone, false);
  assert.ok(buildSftSample(messages));
  assert.equal(analyzeTrajectory([...messages, call('task_complete')[0]]).taskDone, false);
  assert.equal(analyzeTrajectory([...messages, ...call('task_complete', {}, { ok: false })]).taskDone, false);
  assert.equal(analyzeTrajectory([...messages, ...call('task_complete', {}, { ok: true })]).taskDone, true);
});

test('stage self-report, assistant claims and orphan tool results cannot grant verification', () => {
  assert.equal(analyzeTrajectory(call('run_stage_done', {}, { passed: true })).verified, false);
  assert.equal(analyzeTrajectory([{ role: 'assistant', content: 'passed=true' }]).verified, false);
  assert.equal(analyzeTrajectory([{ role: 'tool', tool_call_id: 'unknown', content: '{"passed":true}' }]).verified, false);
  assert.equal(analyzeTrajectory([...complete(), ...call('read_file'), ...call('run_stage_done')]).verified, true);
});

test('case paths must match; missing or contradictory paths never mix passes', () => {
  for (const args of [{ case_path: '/case/b' }, {}, { case_path: '' }, { case_path: 123 }, { case_path: null }]) {
    assert.equal(analyzeTrajectory([...call('foam_solve_verify'), ...call('foam_post_verify', args)]).verified, false);
  }
  assert.equal(analyzeTrajectory([...call('foam_solve_verify'), ...call('foam_post_verify', undefined, { passed: true, case_path: '/case/b' })]).verified, false);
  assert.equal(analyzeTrajectory([...complete('/case/a'), ...call('foam_post_verify', { case_path: '/case/b' })]).verified, false);
});

test('pending, stale and duplicate verifier results do not resurrect old passes', () => {
  const solve = call('foam_solve_verify');
  const post = call('foam_post_verify');
  assert.equal(analyzeTrajectory([...complete(), post[0]]).verified, false);
  assert.equal(analyzeTrajectory([solve[0], ...call('edit_file'), solve[1], ...post]).verified, false);
  assert.equal(analyzeTrajectory([...complete(), ...call('edit_file'), solve[1]]).verified, false);
});

test('unknown or failed verifier result revokes old validation', () => {
  for (const result of [{}, { passed: true, ok: false }, { passed: true, error: 'failed' }, { passed: false }]) {
    const analysis = analyzeTrajectory([...complete(), ...call('foam_post_verify', undefined, result)]);
    assert.equal(analysis.verified, false);
    assert.equal(analysis.verificationFailed, true);
  }
});

function trialResult() {
  return {
    evidence_path: '/case/a/trial-result.json', version: 1, passed: true, value: 0.2,
    configHash: 'a'.repeat(64),
    stages: ['generate', 'mesh', 'solve', 'verify'].map(name => ({
      name, status: 'passed', exitCode: 0, signal: null, timedOut: false,
    })),
    checks: [{ name: 'loss', measured: 0.2, max: 1, passed: true }],
  };
}

test('trial requires paired tool JSON with complete execution checks and evidence path', () => {
  const result = trialResult();
  assert.equal(analyzeTrajectory(call('opt_run_trial', undefined, result)).verified, true);
  for (const changed of [
    { passed: true, evidence_path: result.evidence_path },
    { ...result, evidence_path: '' }, { ...result, stages: result.stages.slice(0, 3) },
    { ...result, checks: [{ name: 'loss', measured: 2, max: 1, passed: true }] },
    { ...result, stages: result.stages.map(stage => ({ ...stage, exitCode: 1 })) },
  ]) assert.equal(analyzeTrajectory(call('opt_run_trial', undefined, changed)).verified, false);
  assert.equal(analyzeTrajectory([...complete(), ...call('opt_run_trial', undefined, { passed: false })]).verified, false);
});

const validKpi = {
  t_react_start: 0, t_window: [60, 100], tau: 20,
  kpis: [{ name: 'conversion', this: 97.6, paper: 99.97 }],
};

test('valid complete KPI evidence passes, including physical zero values', () => {
  assert.equal(kpiCredibility(validKpi).passed, true);
  assert.equal(kpiCredibility({ ...validKpi, kpis: [{ name: 'zero', this: 0, paper: 0 }] }).passed, true);
});

test('missing, empty or malformed KPIs reject', () => {
  assert.equal(kpiCredibility().passed, false);
  const { kpis, ...withoutKpis } = validKpi;
  assert.equal(kpiCredibility(withoutKpis).passed, false);
  for (const invalid of [[], null, {}, [null], [{}]]) {
    const result = kpiCredibility({ ...validKpi, kpis: invalid });
    assert.equal(result.passed, false);
    assert.deepEqual(result.evidence, []);
  }
});

for (const invalid of [null, NaN, Infinity, -Infinity, undefined, '', '0', false]) {
  test(`KPI rejects nonnumeric/nonfinite values: ${String(invalid)}`, () => {
    for (const field of ['this', 'paper', 'init']) {
      const result = kpiCredibility({ ...validKpi, kpis: [{ ...validKpi.kpis[0], [field]: invalid }] });
      assert.equal(result.passed, false, field);
      assert.deepEqual(result.evidence, []);
    }
  });
}

test('invalid times, tau and n_tau reject without numeric coercion', () => {
  for (const field of ['t_react_start', 'tau', 'n_tau']) {
    for (const invalid of [null, NaN, Infinity, -Infinity, '', '20', false, -1]) {
      assert.equal(kpiCredibility({ ...validKpi, [field]: invalid }).passed, false, `${field}=${invalid}`);
    }
  }
  for (const n_tau of [0, Number.MAX_VALUE]) assert.equal(kpiCredibility({ ...validKpi, n_tau }).passed, false);
  for (const t_window of [null, [], [null, 100], [NaN, 100], [60, Infinity], [60, 60], [-1, 100], ['60', 100], [60, 100, 120]]) {
    assert.equal(kpiCredibility({ ...validKpi, t_window }).passed, false);
  }
});