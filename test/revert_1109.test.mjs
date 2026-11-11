// 11-09 对话回滚（对标 OpenChamber）：界面消息序号与服务端对齐、回滚恢复文件、撤销回滚
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const fn = name => { const i = src.indexOf(`function ${name}(`); assert.ok(i > 0, name); const s = src.lastIndexOf('\n', i) + 1; let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(s, j + 1); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-'));
const ctx = vm.createContext({ fs: fs.promises, path, safePath: p => path.join(dir, p), TURN_SNAP_FILE_MAX: 1 << 20 });
for (const n of ['taskHistoryPayload', 'visibleUserIndices', 'recordTurnFile', '_readOrNull', '_writeOrDelete', 'revertTask', 'unrevertTask']) vm.runInContext(fn(n), ctx);

const msgs = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '第一问' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: '[提示] 循环守卫' }, { role: 'assistant', content: 'a1b' },
  { role: 'user', content: '第二问' }, { role: 'assistant', content: 'a2' },
  { role: 'user', content: '第三问' }, { role: 'assistant', content: 'a3' },
];

test('history ordinals skip injected prompts and match visibleUserIndices', () => {
  const t = { id: 't', messages: msgs() };
  const users = ctx.taskHistoryPayload(t).events.filter(e => e.k === 'user');
  assert.deepEqual(JSON.parse(JSON.stringify(users.map(e => [e.text, e.ui]))), [['第一问', 0], ['第二问', 1], ['第三问', 2]]);
  assert.deepEqual([...ctx.visibleUserIndices(t.messages)], [1, 5, 7]);
});

test('revert removes the message and later turns, restores files, and unrevert puts both back', async () => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'created later');
  const t = { id: 't', messages: msgs(), turnSnaps: [
    { msgIndex: 1, files: {} },
    { msgIndex: 5, files: { 'a.txt': 'v1', 'new.txt': null } },     // 第二问那一轮改了 a.txt、新建了 new.txt
    { msgIndex: 7, files: { 'a.txt': 'v1.5' } },
  ] };
  const r = await ctx.revertTask(t, 1);
  assert.equal(r.text, '第二问');
  assert.equal(t.messages.length, 5);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  assert.equal(t.turnSnaps.length, 1);
  const u = await ctx.unrevertTask(t);
  assert.equal(u.messages, 4);
  assert.equal(t.messages.length, 9);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'created later');
  assert.equal(t.revert, null);
});

test('files over the snapshot limit are reported, not silently skipped', async () => {
  const t = { id: 't', messages: msgs(), turnSnaps: [{ msgIndex: 7, files: { 'big.bin': { tooLarge: true } } }] };
  const r = await ctx.revertTask(t, 2);
  assert.deepEqual([...r.skipped], ['big.bin']);
});
