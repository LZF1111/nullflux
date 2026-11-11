import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKpiOutput } from '../opt_validation.js';

test('KPI output requires an actual finite number', () => {
  for (const output of ['', '{}', 'null', '{"kpi":null}', '{"kpi":"2"}', 'NaN', 'Infinity', '12 failed']) {
    assert.throws(() => parseKpiOutput(output), /Invalid KPI/);
  }
  assert.equal(parseKpiOutput('diagnostic\n{"kpi":0}'), 0);
  assert.equal(parseKpiOutput('1.25e-3'), 0.00125);
});