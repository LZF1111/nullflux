import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WS from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
const deadline = startedAt + 82_000;
const events = new EventEmitter();
const children = [];
const requests = [];
const received = [];
const sent = [];
const connections = new Set();
let temporary;
let watcher;
let fileEventTimer;
let socket;
let fake;
let fatal;
let healthy = false;
let issuedTool = false;
let restarted = false;
let failures = 0;
let generation = 0;

function fail(error) {
  fatal ||= error;
  events.emit('change');
}

function waitFor(check, label, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timeout: ${label}`)),
      Math.max(1, Math.min(timeout, deadline - Date.now())));
    function finish(error, value) {
      clearTimeout(timer);
      events.off('change', inspect);
      if (error) reject(error);
      else resolve(value);
    }
    function inspect() {
      try {
        if (fatal) throw fatal;
        const value = check();
        if (value) finish(null, value);
      } catch (error) { finish(error); }
    }
    events.on('change', inspect);
    inspect();
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stopping = true;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server did not exit within 3 seconds'));
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function pass(label) { console.log(`PASS ${label}`); }

try {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-recovery-live-'));
  const app = path.join(temporary, 'app');
  const workspace = path.join(temporary, 'workspace');
  const tasksDirectory = path.join(app, 'tasks');
  fs.mkdirSync(tasksDirectory, { recursive: true });
  fs.mkdirSync(workspace);
  for (const name of ['server.js', 'api_config.js', 'task_transport.js', 'skills.js', 'foam_postproc.js', 'fidelity.js',
    'evolve.js', 'agent_recovery.js', 'cfd_trial.js', 'opt_validation.js', 'package.json']) {
    fs.copyFileSync(path.join(root, name), path.join(app, name));
  }
  for (const name of ['node_modules', 'public']) {
    fs.symlinkSync(path.join(root, name), path.join(app, name),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const marker = path.join(workspace, 'marker.txt');
  const command = process.platform === 'win32'
    ? 'echo MARKER>>marker.txt' : "printf 'MARKER\\n' >> marker.txt";
  const markerContent = process.platform === 'win32' ? 'MARKER\r\n' : 'MARKER\n';
  const input = 'E2E_RECOVERY_LIVE append the marker once, then report RECOVERED.';
  function tasks() {
    return fs.readdirSync(tasksDirectory)
      .filter(name => name.endsWith('.json') && !name.startsWith('_'))
      .flatMap(name => {
        try { return [JSON.parse(fs.readFileSync(path.join(tasksDirectory, name), 'utf8'))]; }
        catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
          throw error;
        }
      });
  }
  watcher = fs.watch(tasksDirectory, () => {
    clearTimeout(fileEventTimer);
    fileEventTimer = setTimeout(() => events.emit('change'), 25);
  });
  watcher.on('error', fail);
  fake = http.createServer((request, response) => {
    let body = '';
    request.on('error', fail);
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const parsed = JSON.parse(body);
        assert.equal(parsed.stream, true);
        const record = { at: Date.now(), generation, healthy, body: parsed };
        requests.push(record);
        let delta;
        if (!issuedTool) {
          assert.equal(parsed.messages.at(-1).role, 'user');
          assert.equal(parsed.messages.at(-1).content, input);
          assert.ok(parsed.tools.some(tool => tool.function.name === 'run_command'));
          issuedTool = true;
          delta = { tool_calls: [{ index: 0, id: 'append_marker_once', type: 'function',
            function: { name: 'run_command', arguments: JSON.stringify({ command, timeout_ms: 5000 }) } }] };
        } else if (!healthy) {
          failures++;
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'intentional recovery outage' }));
          events.emit('change');
          return;
        } else {
          assert.equal(restarted, true, 'endpoint must not recover before restart');
          delta = { content: 'RECOVERED' };
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0,
          delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {},
          finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
        events.emit('change');
      } catch (error) {
        response.writeHead(500);
        response.end('test endpoint assertion failed');
        fail(error);
      }
    });
  });
  fake.on('connection', connection => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
  });
  const fakePort = await listen(fake);
  fake.on('error', fail);
  fs.writeFileSync(path.join(app, 'settings.json'), JSON.stringify({
    provider: 'local', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: '',
    model: 'recovery-live-fake', workspace, maxAutoSteps: 10,
    foamMode: false, mfixMode: false, lbmMode: false, customMode: false,
  }));
  const reservation = http.createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  function boot() {
    generation++;
    const child = spawn(process.execPath, ['server.js'], { cwd: app,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.output = '';
    const capture = chunk => { child.output += chunk.toString(); events.emit('change'); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      if (!child.stopping) fail(new Error(`unexpected server exit: ${code}/${signal}`));
      events.emit('change');
    });
    return child;
  }
  const first = boot();
  await waitFor(() => first.output.includes(`http://127.0.0.1:${port}`), 'first server listening');
  socket = new WS(`ws://127.0.0.1:${port}`);
  socket.on('error', fail);
  socket.on('message', data => {
    try { received.push(JSON.parse(data.toString())); events.emit('change'); }
    catch (error) { fail(error); }
  });
  socket.on('open', () => events.emit('change'));
  await waitFor(() => socket.readyState === WS.OPEN, 'real WebSocket open');
  function send(message) { sent.push(message); socket.send(JSON.stringify(message)); }
  send({ type: 'set_auto', value: true });
  send({ type: 'user', text: input });
  const pending = await waitFor(() => tasks().find(task => task.recovery?.status === 'pending'),
    'persisted recovery.pending after internal 503 retries');
  const pendingAt = Date.now();
  assert.equal(healthy, false);
  assert.equal(pending.autoMode, true);
  assert.equal(!!pending.awaitingApproval, false);
  assert.equal(!!pending.awaitingUserChoice, false);
  assert.equal(!!pending.pendingQuestion, false);
  assert.equal(pending.recovery.attempt, 1);
  assert.match(pending.recovery.lastError, /503/);
  assert.ok(pending.recovery.nextAt - pendingAt >= 28_000);
  assert.ok(pending.recovery.nextAt - pendingAt <= 30_000);
  assert.equal(failures, 2, 'both callLLM internal requests must fail');
  assert.equal(fs.readFileSync(marker, 'utf8'), markerContent);
  assert.equal(pending.messages.filter(message => message.role === 'tool' &&
    message.tool_call_id === 'append_marker_once').length, 1);
  assert.equal(received.filter(message => message.type === 'approval_request').length, 0);
  pass(`persisted pending attempt=1 after ${failures} HTTP 503 responses; nextAt in ${pending.recovery.nextAt - pendingAt}ms`);
  await waitFor(() => first.output.includes('] ended ('), 'failed agent run settled');
  const snapshot = tasks().find(task => task.id === pending.id);
  const originalMessages = structuredClone(snapshot.messages);
  assert.deepEqual(originalMessages.filter(message => message.role === 'user'), [{ role: 'user', content: input }]);
  healthy = true;
  socket.terminate();
  await stop(first);
  restarted = true;
  const second = boot();
  await waitFor(() => second.output.includes(`http://127.0.0.1:${port}`), 'restarted server listening');
  const restored = tasks().find(task => task.id === pending.id);
  assert.equal(restored.recovery.status, 'pending');
  assert.equal(restored.recovery.nextAt, pending.recovery.nextAt);
  assert.equal(requests.filter(record => record.healthy).length, 0);
  pass('restarted without a browser or new user instruction; persisted nextAt unchanged');
  const resumed = await waitFor(() => requests.find(record => record.healthy),
    'headless recovery at original nextAt', 40_000);
  assert.equal(resumed.generation, 2);
  assert.ok(resumed.at >= pending.recovery.nextAt, 'must not resume early');
  assert.ok(resumed.at - pending.recovery.nextAt < 5000, 'must use original deadline');
  assert.deepEqual(resumed.body.messages, originalMessages, 'resume must send only original history');
  pass(`headless recovery used exactly the old messages at nextAt +${resumed.at - pending.recovery.nextAt}ms`);
  await waitFor(() => second.output.includes('] ended (') && tasks().some(task =>
    task.id === pending.id && task.messages.at(-1)?.content === 'RECOVERED' &&
    task.recovery?.status === 'idle'), 'final RECOVERED and persisted idle');
  const finalTasks = tasks();
  assert.equal(finalTasks.length, 1);
  const finalTask = finalTasks[0];
  assert.deepEqual(finalTask.recovery, { attempt: 0, nextAt: null, lastError: '', status: 'idle' });
  assert.deepEqual(finalTask.messages.slice(0, -1), originalMessages);
  assert.equal(finalTask.messages.at(-1).role, 'assistant');
  assert.equal(finalTask.messages.at(-1).content, 'RECOVERED');
  assert.deepEqual(finalTask.messages.filter(message => message.role === 'user'), [{ role: 'user', content: input }]);
  assert.equal(finalTask.messages.flatMap(message => message.tool_calls || []).length, 1);
  assert.equal(finalTask.messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(received.filter(message => message.type === 'tool_call' && message.name === 'run_command').length, 1);
  assert.equal(received.filter(message => message.type === 'tool_result' && message.name === 'run_command').length, 1);
  assert.equal(sent.filter(message => message.type === 'user').length, 1);
  assert.equal(received.filter(message => message.type === 'approval_request').length, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), markerContent);
  assert.equal(requests.length, 4);
  assert.ok(children.every(child => !/\[(?:unhandledRejection|uncaughtException)\]/.test(child.output)));
  pass('tasks JSON recovery=idle attempt=0 nextAt=null; final assistant message=RECOVERED');
  pass('run_command executed once; marker exactly one line; one user message; no approval or tool replay');
} catch (error) {
  process.exitCode = 1;
  console.error(`FAIL ${error.stack || error}`);
  console.error(`TOOL RESULTS: ${JSON.stringify(received.filter(message => message.type === 'tool_result'))}`);
  for (const [index, child] of children.entries()) console.error(`SERVER ${index + 1} TAIL:\n${child.output.slice(-5000)}`);
} finally {
  watcher?.close();
  clearTimeout(fileEventTimer);
  socket?.terminate();
  for (const child of children) {
    try { await stop(child); }
    catch (error) { process.exitCode = 1; console.error(`FAIL cleanup: ${error.message}`); }
  }
  for (const connection of connections) connection.destroy();
  try { await closeServer(fake); }
  catch (error) { process.exitCode = 1; console.error(`FAIL endpoint cleanup: ${error.message}`); }
  try {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    if (temporary) assert.equal(fs.existsSync(temporary), false);
    pass('finally cleanup: child servers stopped, fake endpoint closed, temporary files removed');
  } catch (error) { process.exitCode = 1; console.error(`FAIL temporary cleanup: ${error.message}`); }
}
const elapsed = Date.now() - startedAt;
if (elapsed > 90_000) { process.exitCode = 1; console.error('FAIL exceeded 90s total deadline'); }
console.log(`${process.exitCode ? 'FAILED' : 'ALL PASSED'} in ${(elapsed / 1000).toFixed(2)}s; real server + WS + run_command, fake LLM only; no CFD`);