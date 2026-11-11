import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, buildRequest, validateNotifyConfig, createNotifier, EVENT_KINDS } from '../notify.js';

test('detects webhook kind from URL', () => {
  assert.equal(detectKind('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), 'wecom');
  assert.equal(detectKind('https://oapi.dingtalk.com/robot/send?access_token=x'), 'dingtalk');
  assert.equal(detectKind('https://open.feishu.cn/open-apis/bot/v2/hook/x'), 'feishu');
  assert.equal(detectKind('https://ntfy.sh/my-topic'), 'ntfy');
  assert.equal(detectKind('https://example.test/hook'), 'generic');
});

test('builds provider-specific payloads', () => {
  const ev = { title: 'T', body: 'B', link: 'http://h/app', level: 'high' };
  assert.equal(JSON.parse(buildRequest('wecom', 'u', ev).init.body).msgtype, 'markdown');
  assert.match(JSON.parse(buildRequest('dingtalk', 'u', ev).init.body).markdown.text, /### T/);
  assert.equal(JSON.parse(buildRequest('feishu', 'u', ev).init.body).content.text, 'T\nB\nhttp://h/app');
  const n = buildRequest('ntfy', 'u', ev);
  assert.equal(n.init.headers.Priority, '4');
  assert.equal(n.init.headers.Click, 'http://h/app');
  assert.equal(JSON.parse(buildRequest('generic', 'u', ev).init.body).title, 'T');
});

test('validates config', () => {
  assert.throws(() => validateNotifyConfig({ webhook: 'file:///etc/passwd' }), /http/);
  assert.throws(() => validateNotifyConfig({ webhook: 'not a url' }), /http/);
  const c = validateNotifyConfig({ enabled: true, webhook: 'https://ntfy.sh/t', events: ['solver_done', 'bogus'], publicUrl: 'http://1.2.3.4:5300/' });
  assert.deepEqual(c, { enabled: true, webhook: 'https://ntfy.sh/t', kind: 'ntfy', events: ['solver_done'], publicUrl: 'http://1.2.3.4:5300' });
  assert.deepEqual(validateNotifyConfig({}).events, EVENT_KINDS);
});

test('notifier: disabled sends nothing; enabled sends, filters events and dedupes', async () => {
  const calls = []; let t = 1000;
  let cfg = { enabled: false, webhook: 'https://ntfy.sh/t', kind: 'ntfy', events: ['solver_done'], publicUrl: 'http://h:1' };
  const n = createNotifier({ getConfig: () => cfg, now: () => t, log: { warn() {} },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; } });
  await n.send({ kind: 'solver_done', title: 'a' });
  assert.equal(calls.length, 0);
  cfg = { ...cfg, enabled: true };
  assert.equal((await n.send({ kind: 'solver_done', title: 'a', taskId: 'x1' })).delivered, true);
  assert.equal(calls[0].init.headers.Click, 'http://h:1/app#task=x1');
  assert.equal((await n.send({ kind: 'solver_done', title: 'a' })).skipped, 'dedupe');
  await n.send({ kind: 'approval', title: 'b' });
  assert.equal(calls.length, 1);
  t += 61_000;
  await n.send({ kind: 'solver_done', title: 'a' });
  assert.equal(calls.length, 2);
  assert.equal(n.history().length, 5);
});

test('notifier swallows network errors', async () => {
  const n = createNotifier({ getConfig: () => ({ enabled: true, webhook: 'https://x.test', kind: 'generic' }), log: { warn() {} },
    fetchImpl: async () => { throw new Error('boom'); } });
  const r = await n.send({ kind: 'task_complete', title: 'x' });
  assert.equal(r.delivered, false);
  assert.equal(r.error, 'boom');
});
