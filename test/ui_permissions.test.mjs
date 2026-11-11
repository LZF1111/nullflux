import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('opening or reconnecting a browser never writes task autonomy', () => {
  const sent = [];
  const mode = { checked: true, disabled: false };
  const sandbox = vm.createContext({
    WebSocket: class { send(message) { sent.push(JSON.parse(message)); } },
    location: { host: 'localhost' }, $: () => mode,
    addTerm() {}, addSystem() {}, setTimeout() {},
  });
  vm.runInContext('let ws;', sandbox);
  vm.runInContext(source.slice(source.indexOf('function connect()'), source.indexOf('connect();', source.indexOf('function connect()'))), sandbox);
  sandbox.connect();
  vm.runInContext('ws.onopen(); ws.onclose();', sandbox);
  sandbox.connect();
  vm.runInContext('ws.onopen();', sandbox);
  assert.deepEqual(sent, []);
  assert.equal(mode.disabled, true);
});

test('server task state controls autonomy display without dispatching a change', () => {
  const mode = { checked: true, disabled: false };
  const taskState = { list: [{ id: 'manual', title: 'Manual', autoMode: false }], currentId: 'manual' };
  const select = {};
  const sandbox = vm.createContext({ TASKS_UI: taskState, $: id => id === 'task-select' ? select : mode, escapeHtml: String });
  vm.runInContext(source.slice(source.indexOf('function renderTaskBar()'), source.indexOf('function replayTaskHistory(')), sandbox);
  sandbox.renderTaskBar();
  assert.equal(mode.checked, false);
  assert.equal(mode.disabled, false);
  taskState.list[0].autoMode = true;
  sandbox.renderTaskBar();
  assert.equal(mode.checked, true);
  taskState.list = [];
  sandbox.renderTaskBar();
  assert.equal(mode.checked, false);
  assert.equal(mode.disabled, true);
});