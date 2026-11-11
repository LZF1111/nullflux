import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('runShell detaches pipes held by background children after the shell exits', () => {
  const a = src.indexOf('async function runShell');
  const body = src.slice(a, src.indexOf('\nasync function undoEdit', a));
  assert.match(body, /child\.on\('exit'/);
  assert.match(body, /child\.stdout\.destroy\(\)/);
  assert.match(body, /detached/);
});

// 行为验证：同样的做法能让 "sleep 30 &" 的 shell 在 ~2 s 内收尾
test('destroying pipes after exit lets close fire while a background child keeps running', { skip: process.platform === 'win32' }, async () => {
  const t0 = Date.now();
  const child = spawn('bash', ['-c', 'sleep 30 & echo started']);
  let out = '';
  child.stdout.on('data', d => out += d);
  child.on('exit', () => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 500));
  await new Promise(r => child.on('close', r));
  assert.ok(Date.now() - t0 < 5000);
  assert.match(out, /started/);
});
