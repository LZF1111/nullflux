import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createTaskTransport, taskOwner, syncTaskObservers } from '../task_transport.js';

function socket() {
  const connection = new EventEmitter();
  let state = 1;
  Object.defineProperty(connection, 'readyState', { get: () => state });
  connection.sent = [];
  connection.send = data => { if (state !== 1) throw new Error('closed'); connection.sent.push(data); };
  connection.close = () => { state = 3; };
  return connection;
}

test('stable transport survives detach without changing readonly socket state', () => {
  const connection = socket();
  const viewer = socket();
  const transport = createTaskTransport(connection, () => [transport, viewer]);
  const sessions = new Map([[transport, { autoMode: true }]]);
  transport.send('before');
  connection.close();
  assert.equal(transport.detach(sessions.get(transport)), true);
  transport.send('after');
  assert.equal(connection.readyState, 3);
  assert.equal(transport.readyState, 1);
  assert.equal(transport.isHeadless, true);
  assert.deepEqual(connection.sent, ['before']);
  assert.deepEqual(viewer.sent, ['before', 'after']);
  assert.equal(sessions.size, 1);
});

test('manual and pending approval cannot detach or gain auto authority', () => {
  for (const session of [{ autoMode: false }, { autoMode: true, pendingApproval() {} },
    { autoMode: true, _recoveryApprovalBlocked: true }]) {
    const connection = socket();
    const transport = createTaskTransport(connection);
    connection.close();
    assert.equal(transport.detach(session), false);
    assert.equal(transport.readyState, 3);
    assert.equal(transport.isHeadless, false);
    assert.doesNotThrow(() => transport.send('readonly output'));
  }
});

test('forwarding excludes closed/headless/self and contains send failures', () => {
  const closed = socket();
  closed.close();
  const transport = createTaskTransport(null, () => [transport, closed,
    { isHeadless: true, readyState: 1, send() { assert.fail('headless recursion'); } },
    { readyState: 1, send() { throw new Error('race'); } }]);
  assert.doesNotThrow(() => transport.send('safe'));
});

test('controls resolve only the active owner of the selected task', () => {
  const task = {};
  const owner = { task, _running: true };
  const observer = { task };
  task._runningSession = owner;
  assert.equal(taskOwner(observer), owner);
  const other = { task: {} };
  assert.equal(taskOwner(other), other);
  owner._running = false;
  assert.equal(taskOwner(observer), observer);
});

test('completed owner refreshes observers after context compaction without touching other tasks', () => {
  const task = {};
  const owner = { task, messages: [{ role: 'system', content: 'compacted' }], todos: [{ done: true }], autoMode: false };
  const observer = { task, messages: ['stale'], todos: [], autoMode: true };
  const unrelated = { task: {}, messages: ['unrelated'] };
  syncTaskObservers(owner, [owner, observer, unrelated]);
  assert.equal(observer.messages, owner.messages);
  assert.equal(observer.todos, owner.todos);
  assert.equal(observer.autoMode, false);
  assert.deepEqual(unrelated.messages, ['unrelated']);
});