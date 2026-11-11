// agent_core：编辑匹配、LLM 重试分类/退避、工具输出落盘
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findEditMatch, applyEdit, classifyLlmHttp, parseRetryAfter, llmRetryDelay, isNetworkError, isTimeoutError, clipToolOutput, sweepToolOutput } from '../agent_core.js';

test('edit: exact match replaces once', () => {
  const r = applyEdit('a\nfoo(1);\nb\n', 'foo(1);', 'foo(2);');
  assert.equal(r.ok, true); assert.equal(r.content, 'a\nfoo(2);\nb\n'); assert.equal(r.line, 2);
});

test('edit: trailing whitespace and CRLF differences still match, CRLF is kept', () => {
  const src = 'x = 1;   \r\n  y = 2;\r\nz\r\n';
  const r = applyEdit(src, 'x = 1;\n  y = 2;', 'x = 10;\n  y = 20;');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'x = 10;\r\n  y = 20;\r\nz\r\n');
});

test('edit: curly quotes and dashes in the file match ASCII in old_str', () => {
  const r = applyEdit('say \u201Chi\u201D \u2014 now\n', 'say "hi" - now', 'say "bye"');
  assert.equal(r.ok, true); assert.equal(r.content, 'say "bye"\n');
});

test('edit: several matches are refused with line numbers', () => {
  const r = applyEdit('a\nb\na\n', 'a', 'c');
  assert.equal(r.ok, false); assert.match(r.error, /匹配 2 处/); assert.match(r.error, /1、3/);
  assert.equal(applyEdit('a\nb\na\n', 'a', 'c', true).content, 'c\nb\nc\n');
});

test('edit: a miss with wrong indentation shows the closest lines', () => {
  const src = 'function f() {\n        if (x) {\n     run();\n }\n}\n';
  const m = findEditMatch(src, 'if (x) {\n  run();\n}');
  assert.equal(m.ok, false);
  assert.match(m.error, /最接近的几行/);
  assert.match(m.error, /2:\s+if \(x\) \{/);
  assert.match(m.error, /3:\s+run\(\);/);
});

test('edit: reports when the change is already applied', () => {
  const r = applyEdit('value = 2;\n', 'value = 1;', 'value = 2;');
  assert.equal(r.ok, false); assert.match(r.error, /已经在文件里/);
});

test('edit: unrelated text gives a plain miss', () => {
  assert.match(findEditMatch('alpha\nbeta\n', 'gamma delta').error, /没有相近的行/);
});

test('llm http: retry, fatal and overflow are told apart', () => {
  assert.equal(classifyLlmHttp(429, 'rate limit'), 'retry');
  assert.equal(classifyLlmHttp(429, 'insufficient quota'), 'fatal');
  assert.equal(classifyLlmHttp(402, ''), 'fatal');
  assert.equal(classifyLlmHttp(401, ''), 'fatal');
  assert.equal(classifyLlmHttp(503, 'overloaded'), 'retry');
  assert.equal(classifyLlmHttp(408, ''), 'retry');
  assert.equal(classifyLlmHttp(400, 'bad tool schema'), 'fatal');
  assert.equal(classifyLlmHttp(400, 'This model maximum context length is 200000 tokens'), 'overflow');
  assert.equal(classifyLlmHttp(400, 'prompt is too long: 210000 tokens'), 'overflow');
  assert.equal(classifyLlmHttp(500, 'x', 'false'), 'fatal');
  assert.equal(classifyLlmHttp(404, 'x', 'true'), 'retry');
});

test('llm retry delay: capped backoff, never shorter than retry-after', () => {
  const mid = () => 0.5;
  assert.equal(llmRetryDelay(1, null, mid), 2000);
  assert.equal(llmRetryDelay(2, null, mid), 4000);
  assert.equal(llmRetryDelay(3, null, mid), 8000);
  assert.equal(llmRetryDelay(6, null, mid), 10000);
  assert.equal(llmRetryDelay(1, 30000, mid), 30000);
});

test('retry-after header forms', () => {
  const h = o => k => o[k] ?? null;
  assert.equal(parseRetryAfter(h({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(parseRetryAfter(h({ 'retry-after': '7' })), 7000);
  assert.equal(parseRetryAfter(h({ 'retry-after': new Date(1_000_000 + 5000).toUTCString() }), 1_000_000), 5000);
  assert.equal(parseRetryAfter(h({ })), null);
});

test('network and timeout messages', () => {
  assert.ok(isNetworkError('fetch failed')); assert.ok(isNetworkError('read ECONNRESET'));
  assert.ok(!isNetworkError('API 400: bad request'));
  assert.ok(isTimeoutError('connect_timeout_90s')); assert.ok(isTimeoutError('LLM 流空闲超时 120s'));
});

test('long tool output is clipped and the full text is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tout-'));
  const text = Array.from({ length: 4000 }, (_, i) => 'line ' + i).join('\n');
  const out = clipToolOutput(text, { max: 2000, dir, relBase: dir, name: 'run_command' });
  assert.ok(out.length < 2600);
  const m = /已存 (\S+)，/.exec(out); assert.ok(m, out.slice(1300, 1700));
  assert.equal(fs.readFileSync(path.join(dir, m[1]), 'utf8'), text);
  assert.match(out, /4000 行/);
  assert.equal(clipToolOutput('short', { max: 2000, dir }), 'short');
  assert.equal(sweepToolOutput(dir, 0, Date.now() + 10), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
