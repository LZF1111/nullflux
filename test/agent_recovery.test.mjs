import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { RecoveryManager, isTransientLLMError, repairDanglingToolCalls } from '../agent_recovery.js';
import { createTaskTransport, taskOwner, syncTaskObservers } from '../task_transport.js';

const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function serverSlice(start, end) {
  const first = serverSource.indexOf(start);
  const last = serverSource.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `server function boundaries: ${start}`);
  return serverSource.slice(first, last);
}

function fixture(options = {}) {
  let time = 0;
  let sequence = 0;
  const timers = new Map();
  const writes = [];
  const calls = [];
  const task = { id: 'job1', autoMode: true, messages: [
    { role: 'assistant', tool_calls: [{ id: 'done' }] },
    { role: 'tool', tool_call_id: 'done', content: 'solver already launched' },
  ] };
  const manager = new RecoveryManager({
    now: () => time,
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    persist: current => writes.push(JSON.parse(JSON.stringify(current, (key, value) => key.startsWith('_') ? undefined : value))),
    canResume: current => current.autoMode && !current.awaitingApproval && !current.awaitingUserChoice,
    resume: async current => { calls.push(structuredClone(current.messages)); manager.success(current); },
    ...options,
  });
  async function advance(duration) {
    const end = time + duration;
    for (;;) {
      const next = [...timers.entries()].sort((first, second) => first[1].at - second[1].at)[0];
      if (!next || next[1].at > end) break;
      time = next[1].at;
      timers.delete(next[0]);
      await next[1].callback();
    }
    time = end;
  }
  return { manager, task, timers, writes, calls, advance };
}

test('transient failure resumes existing messages, then success resets and persists', async () => {
  const context = fixture();
  const before = structuredClone(context.task.messages);
  context.manager.failure(context.task, new TypeError('fetch failed'));
  assert.deepEqual(context.task.recovery, { attempt: 1, nextAt: 30_000, lastError: 'fetch failed', status: 'pending' });
  await context.advance(29_999);
  assert.equal(context.calls.length, 0);
  await context.advance(1);
  assert.deepEqual(context.calls, [before]);
  assert.deepEqual(context.task.messages, before);
  assert.equal(context.writes.at(-1).recovery.attempt, 0);
  assert.equal(context.writes.at(-1).recovery.status, 'idle');
});

test('backoff caps at fifteen minutes and permits only eight recovery attempts', async () => {
  let calls = 0;
  const context = fixture({ resume: async () => { calls++; throw new Error('API 503'); } });
  context.manager.failure(context.task, new Error('API 429'));
  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.equal(context.task.recovery.attempt, attempt);
    await context.advance(Math.min(900_000, 30_000 * 2 ** (attempt - 1)));
  }
  assert.equal(calls, 8);
  assert.equal(context.task.recovery.status, 'exhausted');
  assert.equal(context.timers.size, 0);
});

test('restart reconstructs pending timers from serialized task state', async () => {
  const original = fixture();
  original.manager.failure(original.task, new Error('ECONNRESET'));
  const saved = structuredClone(original.writes.at(-1));
  original.manager.dispose();
  const restarted = fixture();
  restarted.manager.restore([saved]);
  await restarted.advance(30_000);
  assert.equal(restarted.calls.length, 1);
  assert.equal(saved.recovery.status, 'idle');
});

test('restart recovers a crash during the LLM request', async () => {
  const context = fixture();
  context.task.recovery = { attempt: 3, nextAt: null, lastError: 'timeout', status: 'running' };
  context.manager.restore([context.task]);
  assert.equal(context.task.recovery.attempt, 4);
  await context.advance(240_000);
  assert.equal(context.calls.length, 1);
  assert.equal(context.task.recovery.attempt, 0);
});

for (const reason of ['stop', 'new_message', 'task_complete']) {
  test(`${reason} cancels recovery durably, including after restart`, async () => {
    const context = fixture();
    context.manager.failure(context.task, new Error('timeout'));
    context.manager.cancel(context.task, reason);
    context.manager.restore([structuredClone(context.writes.at(-1))]);
    await context.advance(1_000_000);
    assert.equal(context.calls.length, 0);
    assert.equal(context.task.recovery.status, 'cancelled');
    assert.equal(context.task.recovery.reason, reason);
  });
}

test('busy task delays without consuming retry attempts', async () => {
  let busy = true;
  const context = fixture({ isBusy: () => busy });
  context.manager.failure(context.task, new Error('timeout'));
  await context.advance(30_000);
  assert.equal(context.calls.length, 0);
  assert.equal(context.task.recovery.attempt, 1);
  assert.equal(context.task.recovery.nextAt, 35_000);
  busy = false;
  await context.advance(5_000);
  assert.equal(context.calls.length, 1);
});

test('manual mode and pending approval remain pending without automatic execution', async () => {
  for (const state of [{ autoMode: false }, { awaitingApproval: true }, { awaitingUserChoice: true }]) {
    const context = fixture();
    Object.assign(context.task, state);
    context.manager.failure(context.task, new Error('fetch failed'));
    context.manager.restore([context.task]);
    await context.advance(1_000_000);
    assert.equal(context.calls.length, 0);
    assert.equal(context.task.recovery.status, 'pending');
    assert.equal(context.writes.at(-1).recovery.status, 'pending');
    assert.equal(context.timers.size, 0);
  }
});

test('mode or approval changes are checked again when timer fires', async () => {
  const context = fixture();
  context.manager.failure(context.task, new Error('fetch failed'));
  context.task.awaitingApproval = true;
  await context.advance(30_000);
  assert.equal(context.calls.length, 0);
  assert.equal(context.task.recovery.status, 'pending');
});

test('auth and invalid model errors never retry', async () => {
  for (const message of ['API 401', 'API 403', 'API 404: invalid model', 'API 503: model does not exist']) {
    const context = fixture();
    assert.equal(context.manager.failure(context.task, new Error(message)), false);
    await context.advance(1_000_000);
    assert.equal(context.calls.length, 0);
    assert.equal(context.task.recovery.status, 'failed');
  }
});

test('classifies fetch causes, timeout, 429 and 5xx without retrying generic failures', () => {
  for (const message of ['fetch failed', 'connect_timeout_180s', 'LLM idle timeout', 'LLM 流空闲超时 90s（已自动中止，可重试）', 'ECONNREFUSED', 'API 429', 'API 502', 'UND_ERR_SOCKET']) {
    assert.equal(isTransientLLMError(new Error(message)), true, message);
  }
  assert.equal(isTransientLLMError(new Error('request failed', { cause: Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }) })), true);
  assert.equal(isTransientLLMError({ status: 503, message: 'unavailable' }), true);
  assert.equal(isTransientLLMError(new Error('API 400: malformed messages')), false);
  assert.equal(isTransientLLMError(new Error('tool execution failed')), false);
});

test('cancellation during an in-flight recovery cannot re-arm a rejected request', async () => {
  let rejectRequest;
  const context = fixture({ resume: () => new Promise((resolve, reject) => { rejectRequest = reject; }) });
  context.manager.failure(context.task, new Error('fetch failed'));
  const pending = context.advance(30_000);
  assert.equal(context.task.recovery.status, 'running');
  context.manager.cancel(context.task, 'stop');
  rejectRequest(new Error('ECONNRESET'));
  await pending;
  assert.equal(context.task.recovery.status, 'cancelled');
  assert.equal(context.timers.size, 0);
});

test('interrupted final attempt exhausts on restart instead of repeating forever', () => {
  const context = fixture();
  context.task.recovery = { attempt: 8, nextAt: null, lastError: 'timeout', status: 'running' };
  context.manager.restore([context.task]);
  assert.equal(context.task.recovery.status, 'exhausted');
  assert.equal(context.timers.size, 0);
});

function serverHarness() {
  const context = fixture();
  const events = [];
  const sandbox = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    AbortController, setImmediate: callback => callback(),
    createTaskTransport, taskOwner, syncTaskObservers,
    setTimeout() { throw new Error('unexpected real timer in server harness'); }, clearTimeout() {},
    sessions: new Map(), TASKS: new Map([[context.task.id, context.task]]),
    SETTINGS: {}, WORKSPACE: 'workspace', SYSTEM_PROMPT_BASE: () => 'system',
    DEFAULT_ENABLED: [], TOOL_GROUPS: { foam: [], opt: [], mfix: [], lbm: [] },
    NEEDS_APPROVAL: new Set(), MODIFYING: new Set(), MAX_AUTO_STEPS_DEFAULT: 10,
    newCheckpoint() {}, broadcastCheckpoints() {}, broadcastTaskState() {},
    buildUserContent: async text => text, autoCompactIfNeeded: async () => {},
    filterTools: () => [], toolsForMode: () => [],
    Evolve: { onLlmStep() {} }, SkillLib: { draftFromTrajectory: () => null },
    workMemToSkillFill: () => ({}), captureToolSignal() {}, clipForHistory: result => result,
    persistTaskNow: context.manager.persist, schedulePersistTask: context.manager.persist,
    _runSummary: () => 'finished',
    RecoveryManager: function (options) { Object.assign(context.manager, options); return context.manager; },
  });
  vm.runInContext(serverSlice('const _SOLVER_EXE', '// 算法契约抽取'), sandbox);
  vm.runInContext(serverSlice('function attachSessionToTask(', 'function taskListPayload('), sandbox);
  vm.runInContext(serverSlice('async function runAgent(', 'function _choiceTimeoutMin('), sandbox);
  vm.runInContext(serverSlice('const _wakePending = new Map()', 'const app = express();'), sandbox);
  const ws = { readyState: 1, send: data => events.push(JSON.parse(data)) };
  const session = { autoMode: true, checkpoints: [], todos: [], enabledTools: new Set(), _ws: ws };
  sandbox.attachSessionToTask(session, context.task);
  sandbox.sessions.set(ws, session);
  return { ...context, sandbox, ws, session, events };
}

test('server runAgent recovers after a completed tool without replay or synthetic user input', async () => {
  const context = serverHarness();
  let llmCalls = 0;
  let toolCalls = 0;
  context.sandbox.execToolWithProgress = async () => { toolCalls++; return 'solver launched'; };
  context.sandbox.callLLM = async () => {
    llmCalls++;
    if (llmCalls === 1) return { role: 'assistant', content: '', tool_calls: [
      { id: 'launch', function: { name: 'run_command', arguments: '{"command":"solver"}' } },
    ] };
    if (llmCalls === 2) throw new Error('fetch failed');
    return { role: 'assistant', content: 'Result checked.' };
  };
  await context.sandbox.runAgent(context.ws, 'Continue FCC.', []);
  assert.equal(toolCalls, 1, JSON.stringify({ llmCalls, events: context.events }));
  assert.equal(context.task.recovery.status, 'pending');
  const savedHistory = structuredClone(context.task.messages);
  await context.advance(30_000);
  assert.equal(llmCalls, 3);
  assert.equal(toolCalls, 1);
  assert.deepEqual(structuredClone(context.task.messages.slice(0, -1)), savedHistory);
  assert.equal(context.task.recovery.status, 'idle');
  assert.equal(context.writes.at(-1).recovery.attempt, 0);
  assert.equal(context.sandbox.sessions.size, 1);
  assert.ok(context.events.some(event => event.type === 'term' && event.line.includes('[LLM recovery]')));
});

test('server busy guard includes any running attached session, not only task owner', async () => {
  const context = serverHarness();
  let calls = 0;
  context.sandbox.callLLM = async () => { calls++; return { role: 'assistant', content: 'Done.' }; };
  context.session._running = true;
  context.manager.failure(context.task, new Error('API 503'));
  await context.advance(30_000);
  assert.equal(calls, 0);
  assert.equal(context.task.recovery.attempt, 1, JSON.stringify({ recovery: context.task.recovery, events: context.events }));
  context.session._running = false;
  await context.advance(5_000);
  assert.equal(calls, 1);
});

test('server preserves manual mode and blocks pending approvals or unmatched tool calls', () => {
  const context = serverHarness();
  context.task.autoMode = false;
  const { ws, s } = context.sandbox._makeHeadlessSession(context.task);
  assert.equal(s.autoMode, false);
  context.sandbox.sessions.delete(ws);
  assert.equal(context.sandbox._canRecoverTask(context.task), false);
  context.task.autoMode = true;
  context.session.pendingApproval = () => {};
  assert.equal(context.sandbox._canRecoverTask(context.task), false);
  context.session.pendingApproval = null;
  context.task.messages.push({ role: 'assistant', tool_calls: [{ id: 'unexecuted' }] });
  assert.equal(context.sandbox._canRecoverTask(context.task), false);
});

test('server _flushWake cannot bypass pending recovery or start another agent', () => {
  const context = serverHarness();
  context.manager.failure(context.task, new Error('API 503'));
  context.sandbox.runAgent = () => { assert.fail('wake bypassed recovery backoff'); };
  vm.runInContext("_wakePending.set('job1', { runs: [{ runId: 'solver' }], timer: null }); _flushWake('job1');", context.sandbox);
  assert.equal(vm.runInContext("_wakePending.get('job1').runs.length", context.sandbox), 1);
});

test('server auth error persists failed state and has no recovery timer', async () => {
  const context = serverHarness();
  context.sandbox.callLLM = async () => { throw new Error('API 401: invalid credentials'); };
  await context.sandbox.runAgent(context.ws, 'Continue.', []);
  assert.equal(context.task.recovery.status, 'failed');
  assert.equal(context.timers.size, 0);
});

test('context overflow from the provider compacts once and re-sends the same step', async () => {
  const context = serverHarness();
  const compacts = [];
  context.sandbox.autoCompactIfNeeded = async (session, ws, signal, force) => { compacts.push(!!force); };
  let calls = 0;
  context.sandbox.callLLM = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('API 400 : prompt is too long'), { contextOverflow: true });
    return { role: 'assistant', content: 'Finished after compaction.' };
  };
  await context.sandbox.runAgent(context.ws, 'Continue.', []);
  assert.equal(calls, 2);
  assert.deepEqual(compacts, [false, true, false]);
  assert.ok(!context.task.recovery || context.task.recovery.status === 'idle', 'overflow must not count as a failure');
  assert.ok(context.events.some(event => event.type === 'term' && event.line.includes('强制压缩')));
  assert.equal(context.events.some(event => event.type === 'error'), false);
});

test('a second overflow in a row is reported instead of looping', async () => {
  const context = serverHarness();
  let calls = 0;
  context.sandbox.callLLM = async () => { calls++; throw Object.assign(new Error('API 400 : prompt is too long'), { contextOverflow: true }); };
  await context.sandbox.runAgent(context.ws, 'Continue.', []);
  assert.equal(calls, 2);
  assert.ok(context.events.some(event => event.type === 'error'));
});

test('a reply cut off by the length limit or a broken stream is continued, at most twice', async () => {
  for (const finish of ['length', 'interrupted']) {
    const context = serverHarness();
    let calls = 0;
    const cut = () => Object.defineProperty({ role: 'assistant', content: 'part ' + calls }, '_finish', { value: finish });
    context.sandbox.callLLM = async () => { calls++; return calls <= 1 ? cut() : { role: 'assistant', content: 'All done.' }; };
    await context.sandbox.runAgent(context.ws, 'Continue.', []);
    assert.equal(calls, 2, finish);
    const nudges = context.task.messages.filter(m => m.role === 'user' && /长度上限|传输中被中断/.test(m.content));
    assert.equal(nudges.length, 1, finish);
    assert.equal(JSON.stringify(context.task.messages).includes('_finish'), false);
  }
  const context = serverHarness();
  let calls = 0;
  context.sandbox.callLLM = async () => { calls++; return Object.defineProperty({ role: 'assistant', content: 'never ends ' + calls }, '_finish', { value: 'length' }); };
  await context.sandbox.runAgent(context.ws, 'Continue.', []);
  const nudges = context.task.messages.filter(m => m.role === 'user' && /长度上限/.test(m.content));
  assert.equal(nudges.length, 2);
});

test('server task writes use rename, reload recovery, and preserve old file on rename failure', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const task = { id: 'job1', messages: [], todos: [], autoMode: true,
    recovery: { attempt: 2, nextAt: 60_000, lastError: 'timeout', status: 'pending' }, _runtime: 'not persisted' };
  const operations = [];
  const sandbox = vm.createContext({
    console: { warn() {}, log() {} }, path, TASKS_DIR: directory, TASKS: new Map(), repairDanglingToolCalls,
    clearTimeout() {}, _taskFile: id => path.join(directory, `${id}.json`),
    fssync: { ...fs,
      writeFileSync: (...args) => { operations.push('write'); fs.writeFileSync(...args); },
      renameSync: (...args) => { operations.push('rename'); fs.renameSync(...args); },
    },
  });
  vm.runInContext('let CURRENT_TASK_ID = null;', sandbox);
  vm.runInContext(serverSlice('function persistTaskNow(', 'function schedulePersistTask('), sandbox);
  vm.runInContext(serverSlice('function loadAllTasks(', 'function _saveTaskMeta('), sandbox);
  sandbox.persistTaskNow(task);
  assert.deepEqual(operations, ['write', 'rename']);
  sandbox.loadAllTasks();
  assert.equal(sandbox.TASKS.get(task.id).recovery.attempt, 2);
  assert.equal(sandbox.TASKS.get(task.id)._runtime, undefined);
  const before = fs.readFileSync(path.join(directory, 'job1.json'), 'utf8');
  sandbox.fssync.renameSync = () => { throw new Error('disk error'); };
  task.recovery.attempt = 3;
  sandbox.persistTaskNow(task);
  assert.equal(fs.readFileSync(path.join(directory, 'job1.json'), 'utf8'), before);
  sandbox.TASKS.clear();
  sandbox.loadAllTasks();
  assert.equal(sandbox.TASKS.size, 1);
  assert.equal(sandbox.TASKS.get(task.id).recovery.attempt, 2);
});
test('repairDanglingToolCalls answers interrupted calls next to their assistant message', async () => {
  const { repairDanglingToolCalls } = await import('../agent_recovery.js');
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'update_todos' } }, { id: 'b', function: { name: 'solver_wait' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  assert.equal(repairDanglingToolCalls(msgs, 'X'), 1);
  assert.deepEqual(msgs.map(m => m.tool_call_id || m.role), ['user', 'assistant', 'a', 'b']);
  assert.equal(msgs[3].content, 'X');
  assert.equal(repairDanglingToolCalls(msgs), 0);
});

test('keepAlive: after maxAttempts keeps retrying at keepAliveDelay instead of exhausting', async () => {
  const context = fixture({ maxAttempts: 2, keepAlive: () => true, keepAliveDelay: 300_000,
    resume: async () => { throw new TypeError('fetch failed'); } });
  context.manager.failure(context.task, new TypeError('fetch failed'));
  await context.advance(30_000);
  await context.advance(60_000);
  assert.equal(context.task.recovery.status, 'pending');
  assert.equal(context.task.recovery.keepAlive, true);
  assert.equal(context.task.recovery.nextAt - 90_000, 300_000);
});

test('without keepAlive, maxAttempts still exhausts', async () => {
  const context = fixture({ maxAttempts: 1, resume: async () => { throw new TypeError('fetch failed'); } });
  context.manager.failure(context.task, new TypeError('fetch failed'));
  await context.advance(30_000);
  assert.equal(context.task.recovery.status, 'exhausted');
});

test('_redirectTarget finds solver log redirect, ignores 2>&1 and /dev/null', () => {
  const src = serverSlice('function _redirectTarget(', 'function _tailOnce(');
  const ctx = { path: { isAbsolute: p => p.startsWith('/'), join: (...a) => a.join('/') } };
  vm.runInNewContext(src + '\nthis.f = _redirectTarget;', ctx);
  assert.equal(ctx.f('mpirun -np 64 foam -parallel > log.smoke 2>&1', '/c'), '/c/log.smoke');
  assert.equal(ctx.f('foam >> /abs/log.run', '/c'), '/abs/log.run');
  assert.equal(ctx.f('foam 2>&1', '/c'), '');
  assert.equal(ctx.f('foam > /dev/null', '/c'), '');
  assert.equal(ctx.f('foam -parallel', '/c'), '');
});
