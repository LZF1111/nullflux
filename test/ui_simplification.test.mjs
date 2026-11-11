import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const readPublic = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const publicHas = name => fs.existsSync(new URL(`../public/${name}`, import.meta.url));
const html = readPublic('index.html');
const source = readPublic('app.js').replace(/\r\n/g, '\n');
const css = readPublic('style.css');
const placeholder = '\u63cf\u8ff0\u76ee\u6807\uff0c\u6216\u6dfb\u52a0\u8bba\u6587\u3001\u7b97\u4f8b\u4e0e\u6570\u636e\u2026';

function sliceSource(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source boundary: ${start}`);
  return source.slice(startIndex, endIndex);
}

function fakeEl(id = '') {
  return {
    id, style: {}, dataset: {}, hidden: false, disabled: false, innerHTML: '', textContent: '',
    value: '', checked: false, listeners: {}, children: [], attrs: {}, classes: new Set(),
    classList: { toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    removeAttribute(name) { delete this.attrs[name]; },
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, click() { this.clicked = true; },
  };
}
function makeControls() {
  return new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, fakeEl(id)]));
}
const withClassList = el => { el.classList._s = el.classes; return el; };

test('monitor chooses only an unambiguous owned run and retains an explicit selection', () => {
  const context = vm.createContext({});
  vm.runInContext(sliceSource('function smPreferredRun(', 'async function smRefreshRuns('), context);
  const runs = [{ runId: 'mine', ownerTaskId: 'task', running: true }, { runId: 'other', ownerTaskId: 'elsewhere', running: true }];
  assert.equal(context.smPreferredRun(runs, 'task', ''), 'mine');
  assert.equal(context.smPreferredRun(runs, 'task', 'other'), 'other');
  assert.equal(context.smPreferredRun(runs, 'missing', ''), '');
  assert.equal(context.smPreferredRun([...runs, { runId: 'mine2', ownerTaskId: 'task', running: true }], 'task', ''), '');
});

test('main app has no CFD flow buttons, handlers or their forced-question templates', () => {
  for (const [name, content] of Object.entries({ html, source })) {
    assert.doesNotMatch(content, /(?:foam|mfix|lbm)-flow-/, name);
    assert.doesNotMatch(content, /带编号的推荐选项|给我决策菜单|等我回完 4 个|等我回 7 个数字|不要替我做选择|一次问一项 \+ 立即应用|严禁.*(?:P3\/P4|M2)/, name);
  }
});

test('removed features are gone from the page, script and public folder', () => {
  for (const id of ['foam-toggle', 'mfix-toggle', 'lbm-toggle', 'custom-toggle', 'gallery-grid', 'img-lightbox', 'checkpoints',
    'nb-host', 'advanced-tools', 'advanced-toggle', 'view-btn', 'view-menu', 'reset-layout', 'compact-btn', 'reset', 'task-rename', 'task-del', 'mode-pills', 'model-info']) {
    assert.ok(!html.includes(`id="${id}"`), `Removed control still in index.html: ${id}`);
  }
  for (const pid of ['foam', 'mfix', 'lbm', 'custom', 'gallery', 'checkpoints']) assert.ok(!html.includes(`data-pid="${pid}"`), pid);
  assert.doesNotMatch(html, /src="\/digitizer\.js"/);
  assert.doesNotMatch(source, /openNotebook|addToGallery|FOAM_STATE|MFIX_STATE|LBM_STATE|CUSTOM_STATE|workspaceMode|vm-legacy|'nb_msg'/);
  for (const [name, content] of Object.entries({ html, source, css })) {
    assert.doesNotMatch(content, /scholar|NFScholar|workflow-select|workflowPlaceholders|workflow-row/i, name);
  }
  for (const f of ['scholar.js', 'scholar-anaglyph.html', 'scholar-poster-v2.html', 'scholar-poster-v3.html', 'welcome.html']) assert.ok(!publicHas(f), f);
  assert.match(html, new RegExp(`<textarea[^>]+id="input"[^>]+placeholder="${placeholder}"`));
});

test('task, context, evidence, skill, safety and simulation controls remain present', () => {
  const controls = makeControls();
  for (const id of ['input', 'send', 'stop', 'auto-mode', 'model-picker', 'settings-btn', 'goal-btn', 'task-fork', 'inspector-toggle',
    'task-select', 'active-file-toggle', 'attachments', 'attach-file', 'attach-image', 'file-picker', 'image-picker',
    'digitize-btn', 'py-picker', 'tools-btn', 'tools-modal', 'skill-body',
    'pending-bar', 'keep-all', 'undo-all', 'kill-all', 'ctx-sub',
    'live-jobs', 'live-machine', 'ov-case', 'ov-body', 'slice-frame', 'geom-frame',
    'sm-run', 'sm-stop', 'sm-resid-canvas', 'sm-resid-legend', 'sm-snap-now', 'sm-snap-strip']) {
    assert.ok(controls.has(id), `Missing control: ${id}`);
  }
  assert.match(html, /id="auto-mode"[^>]*disabled[^>]*role="switch"/);
  assert.match(html, /class="auto-on">[^<]+<\/span><span class="auto-off">[^<]+<\/span>/);
  const tabs = [...html.matchAll(/role="tab" data-context-view="([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['status', 'results', 'files', 'terminal', 'optimize', 'post']);
  for (const pid of ['live', 'todos', 'solver-monitor', 'design', 'terminal', 'editor', 'slice', 'geometry', 'files', 'skills', 'chat']) {
    assert.ok(html.includes(`data-pid="${pid}"`), `Missing panel: ${pid}`);
  }
  for (const c of ["case 'digitize_open':", "case 'skill_saved':", "case 'solver_alert':"]) assert.ok(source.includes(c), c);
  const monitor = sliceSource('async function smPoll()', 'function smRestartTimer()');
  assert.ok(monitor.includes("fetch('/api/foam/run/'"));
  assert.ok(monitor.includes('j.trends'));
  assert.ok(monitor.includes('smDrawResidChart(j.series || [], j.fields || [])'));
});

test('inspector groups panels into tabs with sub-views and remembers the choice', () => {
  const controls = makeControls();
  const panels = new Map([...html.matchAll(/class="panel[^"]*" data-pid="([^"]+)"/g)].map(([, pid]) => [pid, withClassList(fakeEl())]));
  const tabButtons = [...html.matchAll(/data-context-view="([a-z]+)"/g)].map(([, v]) => { const b = withClassList(fakeEl()); b.dataset.contextView = v; return b; });
  const storage = new Map();
  const sandbox = vm.createContext({
    document: {
      body: withClassList(fakeEl()),
      getElementById(id) { assert.ok(controls.has(id), `Dead DOM reference: ${id}`); return controls.get(id); },
      createElement: () => withClassList(fakeEl()),
      querySelectorAll(sel) {
        if (sel === '[data-context-view]') return tabButtons;
        if (sel === '.panel[data-pid="skills"]') return [];
        return [];
      },
      querySelector(sel) {
        const m = sel.match(/data-pid="([^"]+)"/); if (m) return panels.get(m[1]) || null;
        return sel === '.file-menu' ? withClassList(fakeEl()) : null;
      },
      addEventListener() {},
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { dispatchEvent() {} }, Event: class {}, matchMedia: () => ({ matches: false }),
  });
  vm.runInContext('let editor = null;\n' + sliceSource('// NullFlux frontend', '// ====================== Monaco 编辑器'), sandbox);
  const run = code => vm.runInContext(code, sandbox);
  assert.equal(run('contextView'), 'status');
  assert.equal(run("isPanelVisible('live')"), true);
  assert.equal(run("isPanelVisible('todos')"), false);
  assert.equal(panels.get('todos').classes.has('context-inactive'), true);
  assert.equal(panels.get('live').classes.has('context-inactive'), false);
  assert.equal(controls.get('ctx-sub').children.length, 3);
  run("selectSub('slice')");
  assert.equal(run('contextView'), 'post');
  assert.equal(panels.get('slice').classes.has('context-inactive'), false);
  assert.equal(panels.get('editor').classes.has('context-inactive'), true);
  assert.equal(controls.get('ctx-sub').hidden, false);
  run("selectContext('files')");
  assert.equal(controls.get('ctx-sub').hidden, true);
  const saved = JSON.parse(storage.get('nullflux.inspector.v3'));
  assert.equal(saved.context, 'files'); assert.equal(saved.sub.post, 'slice');
  run("setPanelVisible('skills', true)");
  assert.equal(panels.get('skills').style.display, '');
  assert.equal(run("isPanelVisible('skills')"), true);
});

test('send, stop, Auto and attachments still work and idle placeholder stays concise', () => {
  const controls = makeControls();
  const sent = [];
  const sandbox = vm.createContext({
    $: id => { assert.ok(controls.has(id), `Dead DOM reference: ${id}`); return controls.get(id); },
    ws: { readyState: 1, send: message => sent.push(JSON.parse(message)) },
    WebSocket: { OPEN: 1 }, attachments: [], activeTab: null, _phaseStart: 0,
    addTerm() {}, addSystem() {}, addUser() {}, renderAttachments() {},
    armStuckWatchdog() {}, clearStuckWatchdog() {}, showPhase() {}, hidePhase() {},
    startPhaseTick() {}, stopPhaseTick() {}, setTimeout() {},
    onInputKey() {}, onInputChange() {}, confirm: () => false,
  });
  vm.runInContext(sliceSource('function send()', 'let _phaseState ='), sandbox);
  vm.runInContext(sliceSource("$('stop').onclick", 'function send()'), sandbox);
  const attachmentBindings = source.match(/^\$\('attach-(?:file|image)'\)\.onclick = .*;$/gm);
  assert.equal(attachmentBindings?.length, 2);
  vm.runInContext(attachmentBindings.join('\n'), sandbox);
  controls.get('attach-file').onclick();
  controls.get('attach-image').onclick();
  assert.equal(controls.get('file-picker').clicked, true);
  assert.equal(controls.get('image-picker').clicked, true);
  assert.equal(typeof controls.get('input').listeners.keydown, 'function');
  assert.equal(typeof controls.get('input').listeners.input, 'function');

  sandbox.setRunning(false);
  assert.equal(controls.get('input').placeholder, placeholder);
  controls.get('send').onclick();
  assert.deepEqual(sent, []);
  controls.get('input').value = 'Inspect case';
  controls.get('active-file-toggle').checked = true;
  sandbox.activeTab = 'case/0/U';
  sandbox.attachments = [
    { type: 'file', name: 'data.csv', inlineContent: 'x,y\n1,2' },
    { type: 'image', name: 'plot.png', dataUrl: 'data:image/png;base64,AA==' },
  ];
  controls.get('send').onclick();
  assert.equal(sent[0].type, 'user');
  assert.ok(sent[0].text.includes('Inspect case'));
  assert.ok(sent[0].text.includes('x,y\n1,2'));
  assert.deepEqual(sent[0].attachments, [
    { type: 'image', dataUrl: 'data:image/png;base64,AA==', name: 'plot.png' },
    { type: 'context_file', path: 'case/0/U' },
  ]);
  assert.equal(controls.get('stop').disabled, false);
  assert.equal(controls.get('send').disabled, false);
  assert.notEqual(controls.get('input').placeholder, placeholder);
  controls.get('stop').onclick();
  assert.deepEqual(sent.at(-1), { type: 'stop' });
  sandbox.setRunning(false);
  assert.equal(controls.get('input').placeholder, placeholder);
  assert.equal(controls.get('stop').disabled, true);
  controls.get('auto-mode').checked = true;
  controls.get('auto-mode').onchange();
  assert.deepEqual(sent.at(-1), { type: 'set_auto', value: true });
  controls.get('auto-mode').checked = false;
  controls.get('auto-mode').onchange();
  assert.deepEqual(sent.at(-1), { type: 'set_auto', value: false });
  const countBeforeKill = sent.length;
  controls.get('kill-all').onclick();
  assert.equal(sent.length, countBeforeKill);
  sandbox.confirm = () => true;
  controls.get('kill-all').onclick();
  assert.deepEqual(sent.at(-1), { type: 'kill_all' });
});

test('slash commands cover the removed buttons and simulation views', () => {
  const cmds = sliceSource('function send()', 'const finalAtts');
  for (const c of ['clear', 'compact', 'tools', 'py', 'digitize', 'jobs', 'slice', 'geometry', 'case', 'skills', 'help']) {
    assert.ok(cmds.includes(`cmd === '${c}'`), `Missing /${c}`);
  }
});

test('slash menu filters commands by prefix and description, and only for a bare /word', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(sliceSource('const SLASH_COMMANDS =', 'function onInputChange(') + '\nglobalThis.items = slashItems;', sandbox);
  assert.ok(sandbox.items('/').length >= 15);
  assert.equal(JSON.stringify(sandbox.items('/s').map(x => x[0])), '["slice","skills"]');
  assert.equal(JSON.stringify(sandbox.items('/sl').map(x => x[0])), '["slice"]');
  assert.ok(sandbox.items('/切片').some(x => x[0] === 'slice'));
  assert.equal(sandbox.items('/slice cases/a'), null);
  assert.equal(sandbox.items('hello'), null);
  const cmds = sliceSource('function send()', 'const finalAtts');
  for (const [c] of vm.runInContext('SLASH_COMMANDS', sandbox)) {
    assert.ok(cmds.includes(`cmd === '${c}'`) || c === 'python', `menu lists /${c} but send() does not handle it`);
  }
});

test('job paths map to workspace-relative case paths', () => {
  const sandbox = vm.createContext({ LIVE: { workspace: '/home/u/projects/' } });
  vm.runInContext(sliceSource('function liveRel(', 'function liveRsi('), sandbox);
  assert.equal(sandbox.liveRel('/home/u/projects/cases/caseA'), 'cases/caseA');
  assert.equal(sandbox.liveRel('/elsewhere/x'), '/elsewhere/x');
});

test('real CFD tool groups and enabled tool selection remain available', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(sliceSource('const TOOL_LABELS =', 'function renderToolsList()') + '\nglobalThis.labels = TOOL_LABELS;', sandbox);
  for (const name of ['foam_find_tutorial', 'foam_inspect_case', 'foam_run_solver_async', 'foam_solver_stop']) {
    assert.equal(sandbox.labels[name][1], 'foam');
  }
  assert.match(source, /type: 'set_tools', tools: \[\.\.\.TOOL_STATE.enabled\]/);
});
