import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WS from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real agent detaches, keeps one owner, routes reconnect controls, and cancels manual approval', { timeout: 60000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-detached-'));
  const app = path.join(temporary, 'app');
  const workspace = path.join(temporary, 'workspace');
  const events = new EventEmitter();
  const sockets = [];
  const requests = [];
  const held = [];
  let child;
  let output = '';
  let fatal;
  let fake;
  let watcher;
  let taskWatcher;
  let stage = 'auto';
  const fail = error => { fatal ||= error; events.emit('change'); };
  function waitFor(check, label, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`timeout: ${label}\nrequests=${requests.length}\n${JSON.stringify(sockets.map(socket => socket.received.slice(-12)))}\n${output.slice(-6000)}`)), timeout);
      function finish(error, value) {
        clearTimeout(timer);
        events.off('change', inspect);
        error ? reject(error) : resolve(value);
      }
      function inspect() {
        try { if (fatal) throw fatal; const value = check(); if (value) finish(null, value); }
        catch (error) { finish(error); }
      }
      events.on('change', inspect);
      inspect();
    });
  }
  async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
  }
  function reply(response, delta) {
    if (delta.tool_calls) delta.tool_calls.forEach((call, index) => { call.index = index; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
  }
  function tool(id, name, args) {
    return { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }
  async function connect(port) {
    const socket = new WS(`ws://127.0.0.1:${port}`);
    sockets.push(socket);
    socket.received = [];
    socket.on('error', fail);
    socket.on('message', data => {
      try { socket.received.push(JSON.parse(data)); events.emit('change'); } catch (error) { fail(error); }
    });
    await once(socket, 'open');
    await waitFor(() => socket.received.find(message => message.type === 'task_history'), 'initial history');
    return socket;
  }
  const send = (socket, message) => socket.send(JSON.stringify(message));
  const has = (socket, type, predicate = () => true) => socket.received.find(message => message.type === type && predicate(message));
  async function disconnect(socket) {
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  }
  function taskFiles() {
    return fs.readdirSync(path.join(app, 'tasks')).filter(name => /^t.*\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(app, 'tasks', name), 'utf8')));
  }
  try {
    fs.mkdirSync(app);
    fs.mkdirSync(path.join(app, 'tasks'));
    fs.mkdirSync(workspace);
    for (const name of ['server.js', 'api_config.js', 'task_transport.js', 'skills.js', 'foam_postproc.js', 'fidelity.js',
      'evolve.js', 'agent_recovery.js', 'cfd_trial.js', 'opt_validation.js', 'package.json']) {
      fs.copyFileSync(path.join(root, name), path.join(app, name));
    }
    for (const name of ['node_modules', 'public']) {
      fs.symlinkSync(path.join(root, name), path.join(app, name), process.platform === 'win32' ? 'junction' : 'dir');
    }
    fs.writeFileSync(path.join(workspace, 'gate.cjs'), `const fs = require('node:fs');
fs.writeFileSync('waiting', 'ready');
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return;
  clearInterval(timer);
  fs.appendFileSync('marker.txt', 'MARKER\\n');
  console.log('TOOL_CONTINUED');
}, 25);
`);
    watcher = fs.watch(workspace, () => events.emit('change'));
    taskWatcher = fs.watch(path.join(app, 'tasks'), () => events.emit('change'));
    const command = process.platform === 'win32' ? 'C:\\PROGRA~1\\nodejs\\node.exe gate.cjs' : `"${process.execPath}" gate.cjs`;
    fake = http.createServer((request, response) => {
      let body = '';
      request.on('error', fail);
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          assert.equal(parsed.stream, true);
          requests.push(parsed);
          if (stage === 'auto' && requests.length === 1) {
            reply(response, { tool_calls: [tool('marker_once', 'run_command', { command, timeout_ms: 20000 }),
              tool('read_one', 'read_file', { path: 'marker.txt' }), tool('read_two', 'read_file', { path: 'marker.txt' })] });
          } else if (stage === 'manual') {
            reply(response, { tool_calls: [tool('manual_never', 'run_command', { command, timeout_ms: 5000 })] });
          } else {
            const record = { response, parsed, closed: false };
            held.push(record);
            response.on('close', () => { record.closed = true; events.emit('change'); });
          }
          events.emit('change');
        } catch (error) { response.writeHead(500); response.end(); fail(error); }
      });
    });
    const fakePort = await listen(fake);
    fs.writeFileSync(path.join(app, 'settings.json'), JSON.stringify({
      provider: 'local', baseUrl: `http://127.0.0.1:${fakePort}`, model: 'detached-fake', apiKey: '',
      workspace, foamMode: false, mfixMode: false, lbmMode: false, autoResume: false,
    }));
    const reservation = http.createServer();
    const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    child = spawn(process.execPath, ['server.js', '--port', String(port)], {
      cwd: app, env: { ...process.env, HOST: '127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; events.emit('change'); });
    child.on('error', fail);
    await waitFor(() => output.includes(`http://127.0.0.1:${port}`), 'server ready', 20000);
    const first = await connect(port);
    const taskId = has(first, 'task_history').taskId;
    send(first, { type: 'user', text: 'DETACHED_AUTO append marker once.' });
    await waitFor(() => fs.existsSync(path.join(workspace, 'waiting')), 'real run_command is waiting');
    await disconnect(first);
    fs.writeFileSync(path.join(workspace, 'release'), 'go');
    await waitFor(() => held.length === 1, 'detached command and readonly batch finished');
    assert.equal(fs.readFileSync(path.join(workspace, 'marker.txt'), 'utf8'), 'MARKER\n');
    assert.equal(held[0].parsed.messages.filter(message => message.role === 'tool').length, 3);
    assert.equal(output.includes('ended (aborted=true)'), false);

    const observer = await connect(port);
    await waitFor(() => has(observer, 'agent_start') && has(observer, 'agent_phase'), 'reconnect sees running owner');
    send(observer, { type: 'task_delete', id: taskId });
    await waitFor(() => has(observer, 'term', message => message.line.includes('先停止再删除')), 'running task delete refused');
    send(observer, { type: 'task_new', title: 'isolated observer task' });
    const other = await waitFor(() => has(observer, 'task_history', message => message.taskId !== taskId), 'observer new task');
    send(observer, { type: 'stop' });
    await waitFor(() => has(observer, 'agent_end'), 'stop other task acknowledged');
    assert.equal(held[0].closed, false, 'stop on another task must not abort owner');
    send(observer, { type: 'task_delete', id: other.taskId });
    await waitFor(() => has(observer, 'task_history', message => message.taskId === taskId && message.events.some(event => event.k === 'tool')), 'delete switches only selected task');
    send(observer, { type: 'set_auto', value: false });
    send(observer, { type: 'set_auto', value: true });
    send(observer, { type: 'user', text: 'STEER_OWNER keep the marker exactly once.' });
    await waitFor(() => has(observer, 'term', message => message.line.includes('已收到你的新输入')), 'steer routed to owner');
    reply(held[0].response, { content: 'OWNER_STREAM' });
    await waitFor(() => held.length === 2, 'owner consumes steer without a second run');
    assert.ok(held[1].parsed.messages.some(message => message.role === 'user' && String(message.content).includes('STEER_OWNER')));
    await waitFor(() => has(observer, 'delta', message => message.text?.includes('OWNER_STREAM')), 'reconnected observer receives live text');
    send(observer, { type: 'stop' });
    await waitFor(() => /ended \(aborted=true, taskComplete=false\)/.test(output) &&
      taskFiles().find(task => task.id === taskId)?.recovery?.status === 'cancelled', 'stop aborts original owner LLM');
    assert.equal((output.match(/\] started/g) || []).length, 1);
    assert.equal(fs.readFileSync(path.join(workspace, 'marker.txt'), 'utf8'), 'MARKER\n');
    assert.equal(taskFiles().find(task => task.id === taskId).autoMode, true);
    console.log('PASS auto detach, readonly output, single execution, task isolation, realtime reconnect, steer and stop');

    stage = 'manual';
    observer.received.length = 0;
    send(observer, { type: 'task_new', title: 'manual approval task' });
    const manual = await waitFor(() => has(observer, 'task_history', message => message.title === 'manual approval task'), 'manual task created');
    send(observer, { type: 'set_auto', value: false });
    send(observer, { type: 'user', text: 'MANUAL must require approval.' });
    await waitFor(() => has(observer, 'approval_request'), 'manual approval required');
    await disconnect(observer);
    await waitFor(() => taskFiles().find(task => task.id === manual.taskId)?.messages.some(message =>
      message.role === 'tool' && message.tool_call_id === 'manual_never'), 'manual cancellation persisted');
    const reconnected = await connect(port);
    assert.equal(has(reconnected, 'agent_start'), undefined);
    const manualTask = taskFiles().find(task => task.id === manual.taskId);
    assert.equal(manualTask.autoMode, false);
    assert.equal(!!manualTask.awaitingApproval, false);
    assert.equal(fs.readFileSync(path.join(workspace, 'marker.txt'), 'utf8'), 'MARKER\n');
    assert.equal(requests.length, 4);
    assert.doesNotMatch(output, /unhandledRejection|uncaughtException/);
    console.log('PASS manual approval disconnect cancels without auto approval or command replay');
  } finally {
    watcher?.close();
    taskWatcher?.close();
    for (const socket of sockets) socket.terminate();
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
          killer.on('error', resolve);
          killer.on('exit', resolve);
        });
      } else child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
    for (const record of held) record.response.destroy();
    if (fake?.listening) await new Promise(resolve => { fake.close(resolve); fake.closeAllConnections(); });
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});