import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fssync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const a = src.indexOf('let _foamSnap'); const b = src.indexOf('async function solverWait');
const ctx = vm.createContext({ fssync, path, setInterval, clearInterval, Date, WORKSPACE: process.cwd() });
vm.runInContext(src.slice(a, b).replace(/^let _foamSnap/m, 'var _foamSnap'), ctx);

test('wakeable sleep wakes on user steer and on abort', async () => {
  const s = { _steerQueue: [] };
  setTimeout(() => s._steerQueue.push({ text: 'x' }), 100);
  const r = await ctx._wakeableSleep(60_000, s);
  assert.equal(r.woke, true);
  assert.match(r.why, /新消息/);
  const r2 = await ctx._wakeableSleep(60_000, { aborted: true });
  assert.equal(r2.woke, true);
});

test('wakeable sleep runs to the end when nothing happens', async () => {
  const r = await ctx._wakeableSleep(50, {});
  assert.equal(r.woke, false);
});

test('run_command routes leading sleep through the wakeable sleep', () => {
  assert.match(src, /\^\\s\*sleep\\s\+\(\\d\+\)/);
  assert.match(src, /_wakeableSleep\(Number\(sm\[1\]\) \* 1000, session\)/);
});
