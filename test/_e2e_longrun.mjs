// Temporary e2e: fake OpenAI endpoint + real server; verifies detached run, restart reattach, auto-wake.
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fileURLToPath } from 'url';
import WS from 'ws';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nfe2e-'));
const APP = path.join(TMP, 'app');
fs.mkdirSync(APP);
for (const f of ['server.js', 'api_config.js', 'task_transport.js', 'skills.js', 'foam_postproc.js', 'fidelity.js', 'evolve.js', 'agent_recovery.js', 'cfd_trial.js', 'opt_validation.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
const LT = process.platform === 'win32' ? 'junction' : 'dir';
if (process.platform === 'win32') fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), LT);
else fs.cpSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), { recursive: true, dereference: true });
fs.symlinkSync(path.join(ROOT, 'public'), path.join(APP, 'public'), LT);
const CASE = path.join(TMP, 'case'); fs.mkdirSync(CASE);
const WS_DIR = path.join(TMP, 'ws'); fs.mkdirSync(WS_DIR);

// fake LLM: step 1 launch job, then task_complete; after wake -> task_complete
let llmCalls = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    llmCalls.push(body);
    const last = body.messages[body.messages.length - 1];
    const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    let delta;
    if (/E2E_START/.test(lastText)) delta = { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'foam_run_solver_async', arguments: JSON.stringify({ case_path: CASE, command: 'node -e "console.log(\'Time = 1\');setTimeout(()=>{console.log(\'End\');process.exit(3)},6000)"' }) } }] };
    else if (last.role === 'tool' && /已启动求解器/.test(lastText)) delta = { content: '已启动，等结果。' };
    else if (/后台作业结束|\[task_complete\]/.test(lastText)) delta = { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'task_complete', arguments: JSON.stringify({ summary: 'E2E_WOKE_OK' }) } }] };
    else delta = { content: 'ok' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const fakePort = fake.address().port;
fs.writeFileSync(path.join(APP, 'settings.json'), JSON.stringify({ provider: 'local', baseUrl: `http://127.0.0.1:${fakePort}`, model: 'fake', apiKey: '', foamMode: true, workspace: WS_DIR, maxAutoSteps: 12 }));

const PORT = 5300 + Math.floor(Math.random() * 300);
function boot() {
  const p = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d);
  return p;
}
const REPORT = path.join(os.tmpdir(), 'nf_e2e_report.txt');
fs.writeFileSync(REPORT, '');
const _log = console.log;
console.log = (...a) => { fs.appendFileSync(REPORT, a.join(' ') + '\n'); _log(...a); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } throw new Error('timeout: ' + what); }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const runsApi = async () => (await (await fetch(`http://127.0.0.1:${PORT}/api/foam/runs`)).json()).runs;

let srv = boot();
try {
  await until(() => /监听/.test(srv.out), 15000, 'boot1');
  const ws = new WS(`ws://127.0.0.1:${PORT}`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'user', text: 'E2E_START' }));
  await until(async () => (await runsApi()).some(r => r.running), 15000, 'job started');
  const runId = (await runsApi())[0].runId;
  ok(fs.existsSync(path.join(CASE, `log.nullflux.${runId}`)), 'log file written in case dir');
  await sleep(1500);
  ws.close();
  // restart server mid-job: job must survive and be reattached
  srv.kill(); await sleep(1000);
  let idx = ''; try { idx = fs.readFileSync(path.join(APP, 'tasks', '_runs.json'), 'utf8'); } catch (e) { idx = 'NO INDEX ' + e.message; }
  console.log('DEBUG index:', idx.slice(0, 600));
  try { const m = JSON.parse(idx)[0]; process.kill(m.pid, 0); console.log('DEBUG pid alive', m.pid); } catch (e) { console.log('DEBUG pid check', e.code || e.message); }
  console.log('DEBUG log:', fs.readFileSync(path.join(CASE, `log.nullflux.${runId}`), 'utf8'));
  srv = boot();
  await until(() => /监听/.test(srv.out), 15000, 'boot2');
  ok(/重新接管 1 个后台作业/.test(srv.out), 'reattached after restart');
  const r2 = (await runsApi()).find(r => r.runId === runId);
  ok(r2 && r2.running, 'job still running after restart');
  const n0 = llmCalls.length;
  // no browser connected: job ends -> headless wake -> fake LLM sees 后台作业结束
  await until(() => llmCalls.slice(n0).some(b => JSON.stringify(b.messages.slice(-1)).includes('后台作业结束')), 20000, 'auto-wake');
  const r3 = (await runsApi()).find(r => r.runId === runId);
  ok(r3 && !r3.running && r3.exitCode === 3, `exit code from marker (=${r3 && r3.exitCode})`);
  const wakeMsg = llmCalls.slice(n0).map(b => JSON.stringify(b.messages.slice(-1))).find(s => s.includes('后台作业结束'));
  ok(/End/.test(wakeMsg), 'wake message carries log tail');
  console.log('DEBUG wake:', String(wakeMsg).slice(0, 800));
  await sleep(4000);
  console.log('DEBUG srv tail:', srv.out.slice(-2500));
  console.log('DEBUG last llm msgs:', JSON.stringify(llmCalls[llmCalls.length - 1].messages.slice(-3)).slice(0, 2000));
  await until(() => /taskComplete=true/.test(srv.out), 10000, 'task_complete after wake');
  ok(true, 'agent completed after wake');
} catch (e) { console.log('FAIL ' + e.message); console.log(srv.out.slice(-3000)); process.exitCode = 1; }
finally { srv.kill(); fake.close(); await sleep(500); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
