// node test/e2e_question.mjs —— 有作业在跑时提问不阻塞 + 提问超时按推荐方案继续
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import WS from 'ws';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nfq-'));
const APP = path.join(TMP, 'app'); fs.mkdirSync(APP);
for (const f of ['server.js', 'api_config.js', 'task_transport.js', 'skills.js', 'foam_postproc.js', 'fidelity.js', 'evolve.js', 'agent_recovery.js', 'cfd_trial.js', 'opt_validation.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
const LT = process.platform === 'win32' ? 'junction' : 'dir';
if (process.platform === 'win32') fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), LT);
else fs.cpSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), { recursive: true, dereference: true });
fs.symlinkSync(path.join(ROOT, 'public'), path.join(APP, 'public'), LT);
const CASE = path.join(TMP, 'case'); fs.mkdirSync(CASE);
const WS_DIR = path.join(TMP, 'ws'); fs.mkdirSync(WS_DIR);

const seen = [];
let asked = 0;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const last = body.messages[body.messages.length - 1];
    const txt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    seen.push(txt);
    let delta;
    if (/Q_START/.test(txt)) delta = { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'foam_run_solver_async', arguments: JSON.stringify({ case_path: CASE, command: 'node -e "setTimeout(()=>process.exit(0),60000)"' }) } }] };
    else if (last.role === 'tool' && /已启动求解器/.test(txt) && !asked) { asked++; delta = { content: '需要你选一个方案：\n1. 不改继续跑（推荐）\n2. 延长时长\n请选择？' }; }
    else if (/问题已转给用户/.test(txt)) delta = { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'update_todos', arguments: JSON.stringify({ items: [{ text: '后处理脚本', done: false }] }) } }] };
    else if (/未回复\]/.test(txt)) delta = { tool_calls: [{ index: 0, id: 'c3', type: 'function', function: { name: 'task_complete', arguments: JSON.stringify({ summary: 'Q_TIMEOUT_OK', force: true }) } }] };
    else delta = { content: '继续等待作业。' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(APP, 'settings.json'), JSON.stringify({ provider: 'local', baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'fake', apiKey: '', foamMode: true, workspace: WS_DIR, maxAutoSteps: 12, choiceTimeoutMin: 0.05 }));
const PORT = 5600 + Math.floor(Math.random() * 300);
const srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.out = ''; srv.stdout.on('data', d => srv.out += d); srv.stderr.on('data', d => srv.out += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(200); } throw new Error('timeout: ' + what); }
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
try {
  await until(() => /监听/.test(srv.out), 15000, 'boot');
  const ws = new WS(`ws://127.0.0.1:${PORT}`);
  const terms = [];
  ws.on('message', d => { try { const m = JSON.parse(d); if (m.type === 'term') terms.push(m.line); } catch {} });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'set_auto', value: true }));
  ws.send(JSON.stringify({ type: 'user', text: 'Q_START' }));
  await until(() => seen.some(s => /问题已转给用户/.test(s)), 15000, 'non-blocking carry');
  ok(terms.some(l => /非阻塞/.test(l)), '有作业在跑时提问不阻塞、agent 继续工作');
  await until(() => seen.some(s => /未回复\]/.test(s)), 15000, 'choice timeout');
  ok(true, '提问超时后按推荐方案唤醒 agent');
  await until(() => /taskComplete=true/.test(srv.out), 10000, 'complete');
  ok(true, '超时唤醒后 agent 可继续收尾');
  ws.close();
} catch (e) { ok(false, e.message); console.log(srv.out.slice(-2000)); }
finally { srv.kill(); fake.close(); try { process.kill(-1, 0); } catch {} await sleep(500); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
