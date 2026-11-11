import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const ctx = vm.createContext({ process });
vm.runInContext(grab('const PRUNE_KEEP', '\n// 非流式、无工具的一次性调用').replace(/^const /gm, 'var '), ctx);

const big = n => 'H'.repeat(900) + 'x'.repeat(n) + 'T'.repeat(500);
const sess = () => ({ messages: [
  { role: 'system', content: 'sys' },
  ...Array.from({ length: 10 }, (_, i) => ({ role: 'tool', tool_call_id: 't' + i, content: big(8000) })),
  ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool', tool_call_id: 'r' + i, content: big(8000) })),
] });

test('old large tool outputs are cut to head and tail, recent ones kept', () => {
  const s = sess();
  const gain = ctx.pruneOldToolResults(s);
  assert.ok(gain > 12000);
  const old = s.messages[1].content;
  assert.ok(old.length < 1500 && old.startsWith('H'.repeat(800)) && old.endsWith('T'.repeat(400)));
  assert.ok(old.includes('旧工具输出已裁剪'));
  for (const m of s.messages.slice(-8)) assert.equal(m.content.length, 8000 + 1400);
  assert.equal(s.messages[1].tool_call_id, 't0');
});

test('second call is a no-op (batching keeps the prompt cache stable)', () => {
  const s = sess();
  ctx.pruneOldToolResults(s);
  const snap = JSON.stringify(s.messages);
  assert.equal(ctx.pruneOldToolResults(s), 0);
  assert.equal(JSON.stringify(s.messages), snap);
});

test('small gains are not pruned; PRUNE=0 disables', () => {
  const s = { messages: [{ role: 'system', content: 's' }, { role: 'tool', content: big(1500) }, { role: 'tool', content: big(1500) }, ...Array.from({ length: 8 }, () => ({ role: 'user', content: 'u' }))] };
  assert.equal(ctx.pruneOldToolResults(s), 0);
  process.env.PRUNE = '0';
  try { assert.equal(ctx.pruneOldToolResults(sess()), 0); } finally { delete process.env.PRUNE; }
});
