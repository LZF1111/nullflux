// server.js 里真实的 callLLM / consumeOpenAIStream：重试分类、退避、断流处理
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { resolveChatConfig } from '../api_config.js';
import { classifyLlmHttp, parseRetryAfter, isNetworkError, isTimeoutError } from '../agent_core.js';

const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const slice = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };

function harness(responses, { stream } = {}) {
  const sent = [], delays = [];
  let calls = 0;
  const ctx = vm.createContext({
    SETTINGS: { provider: 'sf', baseUrl: 'https://llm.test', apiKey: 'k', model: 'm' },
    resolveChatConfig, AbortController, AbortSignal, clearTimeout, clearInterval, process, TextDecoder, Date, JSON, Object, Error,
    setTimeout: (fn, ms) => { if (ms < 60_000 && ms !== 90000) { delays.push(ms); fn(); } return 0; },
    setInterval: () => 0,
    LLM_CONNECT_TIMEOUT_MS: 90000, TOOLS: [], sanitizeToolCallArgs: () => 0,
    _combineSignals: (...s) => s.find(Boolean), _accumUsage() {},
    classifyLlmHttp, parseRetryAfter, isNetworkError, isTimeoutError,
    llmRetryDelay: (attempt, ra) => ra || attempt * 10,
    fetch: async () => {
      const r = responses[Math.min(calls, responses.length - 1)]; calls++;
      if (r instanceof Error) throw r;
      return r;
    },
  });
  vm.runInContext(slice('async function callLLM(', 'function _combineSignals('), ctx);
  if (stream) vm.runInContext(slice('async function consumeOpenAIStream(', '// 每个任务累计 LLM 用量'), ctx);
  else ctx.consumeOpenAIStream = async () => 'ok';
  const ws = { send: d => sent.push(JSON.parse(d)) };
  return { ctx, ws, sent, delays, calls: () => calls };
}
const http = (status, body = '', headers = {}) => ({ ok: false, status, text: async () => body, headers: { get: k => headers[k] ?? null } });
const ok = { ok: true };
function sse(chunks, failAfter = false) {
  const enc = new TextEncoder(); let i = 0;
  return { ok: true, body: { getReader: () => ({
    read: async () => {
      if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
      if (failAfter) throw new Error('terminated');
      return { done: true };
    },
    cancel() {},
  }) } };
}
const delta = o => 'data: ' + JSON.stringify({ choices: [{ delta: o.delta || {}, finish_reason: o.finish || null }] }) + '\n';

test('429 and 5xx are retried with backoff until the call succeeds', async () => {
  const h = harness([http(429, 'rate limited'), http(503, 'overloaded'), ok]);
  assert.equal(await h.ctx.callLLM([], h.ws), 'ok');
  assert.equal(h.calls(), 3);
  assert.deepEqual(h.delays, [10, 20]);
  assert.equal(h.sent.filter(m => m.type === 'term' && /LLM 重试 [12]\/6/.test(m.line)).length, 2);
});

test('retry-after is honoured and capped at 15 minutes', async () => {
  const h = harness([http(429, 'slow down', { 'retry-after': '7' }), ok]);
  await h.ctx.callLLM([], h.ws);
  assert.deepEqual(h.delays, [7000]);
  const far = harness([http(429, 'slow down', { 'retry-after': '86400' }), ok]);
  far.ctx.setTimeout = (fn, ms) => { if (ms !== 90000) { far.delays.push(ms); fn(); } return 0; };
  await far.ctx.callLLM([], far.ws);
  assert.deepEqual(far.delays, [15 * 60_000]);
});

test('auth, quota and ordinary 4xx fail at once', async () => {
  for (const r of [http(401, 'bad key'), http(402, 'pay'), http(429, 'insufficient quota'), http(400, 'bad tool schema')]) {
    const h = harness([r, ok]);
    await assert.rejects(h.ctx.callLLM([], h.ws), /API 4\d\d/);
    assert.equal(h.calls(), 1);
  }
});

test('context overflow is flagged and not retried here', async () => {
  const h = harness([http(400, 'prompt is too long: 210000 tokens > 200000'), ok]);
  await assert.rejects(h.ctx.callLLM([], h.ws), e => e.contextOverflow === true);
  assert.equal(h.calls(), 1);
});

test('a permanently failing endpoint stops after the retry cap', async () => {
  const h = harness([http(500, 'boom')]);
  await assert.rejects(h.ctx.callLLM([], h.ws), /API 500/);
  assert.equal(h.calls(), 7);
});

test('timeouts are retried at most three times, other network errors up to the cap', async () => {
  const t = harness([new Error('connect_timeout_90s')]);
  await assert.rejects(t.ctx.callLLM([], t.ws), /connect_timeout/);
  assert.equal(t.calls(), 4);
  const n = harness([new Error('fetch failed'), new Error('read ECONNRESET'), ok]);
  assert.equal(await n.ctx.callLLM([], n.ws), 'ok');
  assert.equal(n.calls(), 3);
  const other = harness([new Error('Unexpected token < in JSON'), ok]);
  await assert.rejects(other.ctx.callLLM([], other.ws), /Unexpected token/);
  assert.equal(other.calls(), 1);
});

test('a user stop during the backoff wait ends the call', async () => {
  const h = harness([http(503, 'x'), ok]);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(h.ctx.callLLM([], h.ws, ac.signal));
  assert.equal(h.calls(), 1);
});

test('stream: a normal reply carries its finish reason, hidden from JSON', async () => {
  const h = harness([sse([delta({ delta: { content: 'hello' } }), delta({ finish: 'stop' }), 'data: [DONE]\n'])], { stream: true });
  const msg = await h.ctx.callLLM([], h.ws);
  assert.equal(msg.content, 'hello');
  assert.equal(msg._finish, 'stop');
  assert.equal(JSON.stringify(msg).includes('_finish'), false);
});

test('stream: an empty stream that just ends is retried as a network error', async () => {
  const h = harness([sse([]), sse([delta({ delta: { content: 'second try' } }), delta({ finish: 'stop' })])], { stream: true });
  const msg = await h.ctx.callLLM([], h.ws);
  assert.equal(msg.content, 'second try');
  assert.equal(h.calls(), 2);
});

test('stream: text cut off mid-way is kept and marked interrupted, not re-sent', async () => {
  for (const failAfter of [false, true]) {
    const h = harness([sse([delta({ delta: { content: 'partial answ' } })], failAfter), ok], { stream: true });
    const msg = await h.ctx.callLLM([], h.ws);
    assert.equal(msg.content, 'partial answ');
    assert.equal(msg._finish, 'interrupted');
    assert.equal(h.calls(), 1);
  }
});

test('stream: a break while a tool call is being written is an error, not a half call', async () => {
  const tc = delta({ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"a' } }] } });
  const h = harness([sse([tc], true), ok], { stream: true });
  await assert.rejects(h.ctx.callLLM([], h.ws), e => e.partialOutput === true);
  assert.equal(h.calls(), 1);
});

test('stream: [DONE] without finish_reason counts as a complete reply', async () => {
  const h = harness([sse([delta({ delta: { content: 'done' } }), 'data: [DONE]\n'])], { stream: true });
  const msg = await h.ctx.callLLM([], h.ws);
  assert.equal(msg._finish, null);
});
