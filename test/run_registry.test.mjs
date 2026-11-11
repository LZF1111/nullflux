import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('job registry immediately retains all live jobs and atomically replaces history', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mto-runs-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '_runs.json');
  const runs = new Map();
  for (let index = 0; index < 205; index++) runs.set(String(index), { runId: String(index), logFile: 'log', ended: 0 });
  for (let index = 0; index < 250; index++) runs.set(`done${index}`, { runId: `done${index}`, logFile: 'log', ended: Date.now() });
  const sandbox = vm.createContext({ fssync: { ...fs }, path, RUNS_INDEX: filename, SOLVER_RUNS: runs, console: { warn() {} } });
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function _persistRuns()'), source.indexOf('function _pidAlive(')), sandbox);
  sandbox._persistRuns();
  const saved = fs.readFileSync(filename, 'utf8');
  const registry = JSON.parse(saved);
  assert.equal(registry.filter(run => !run.ended).length, 205);
  assert.equal(registry.filter(run => run.ended).length, 200);
  assert.equal(fs.existsSync(filename + '.tmp'), false);
  sandbox.fssync.renameSync = () => { throw new Error('injected rename failure'); };
  runs.clear();
  sandbox._persistRuns();
  assert.equal(fs.readFileSync(filename, 'utf8'), saved);
});