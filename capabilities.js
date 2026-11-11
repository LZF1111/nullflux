// NullFlux 能力层：求解器环境自动探测、官方技能包、MCP 客户端（stdio JSON-RPC）。
// 不依赖 server.js 的全局；server.js 只负责接线（端点、提示词、工具表）。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: opts.timeout || 15000, maxBuffer: 4 << 20, windowsHide: true, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err ? (err.code ?? -1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
});
const exists = p => { try { return fssync.existsSync(p); } catch { return false; } };

// ---------------------------------------------------------------- 求解器环境：不需要用户填路径
// 顺序：已 source 的环境变量 → 常见安装位置（ESI vXXXX、Foundation N、发行版包）→ PATH 里的求解器回推。取版本最新的一个。
function foamCandidates() {
  const home = os.homedir(), out = [];
  if (process.env.WM_PROJECT_DIR) out.push(path.join(process.env.WM_PROJECT_DIR, 'etc', 'bashrc'));
  if (process.env.FOAM_BASH) out.push(process.env.FOAM_BASH);
  const roots = [path.join(home, 'OpenFOAM'), '/opt', '/usr/lib/openfoam', '/usr/local', '/opt/OpenFOAM', '/opt/openfoam'];
  for (const r of roots) {
    let ents = []; try { ents = fssync.readdirSync(r); } catch { continue; }
    for (const e of ents) if (/^(OpenFOAM|openfoam)[-_]?(v?\d+(\.\d+)?|dev)?$/i.test(e)) out.push(path.join(r, e, 'etc', 'bashrc'));
  }
  return [...new Set(out)].filter(exists);
}
const foamVersionKey = p => { const m = /(?:openfoam|OpenFOAM)[-_]?v?(\d+)/.exec(p); return m ? +m[1] : 0; };
export async function detectEnv() {
  const env = { platform: process.platform, cores: os.availableParallelism?.() ?? os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), checkedAt: Date.now() };
  // OpenFOAM
  const foam = { found: false, candidates: [] };
  if (process.platform === 'win32') {
    const w = await run('wsl.exe', ['bash', '-lc', 'for f in ~/OpenFOAM/OpenFOAM-*/etc/bashrc /opt/openfoam*/etc/bashrc /usr/lib/openfoam/openfoam*/etc/bashrc; do [ -f "$f" ] && echo "$f"; done'], { timeout: 20000 });
    foam.candidates = w.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    foam.via = 'wsl';
  } else foam.candidates = foamCandidates();
  foam.candidates.sort((a, b) => foamVersionKey(b) - foamVersionKey(a));
  if (foam.candidates.length) {
    const bashrc = foam.candidates[0];
    const probe = `source "${bashrc}" >/dev/null 2>&1; echo "VER=$WM_PROJECT_VERSION"; echo "DIR=$WM_PROJECT_DIR"; echo "TUT=$FOAM_TUTORIALS"; for c in blockMesh snappyHexMesh simpleFoam pimpleFoam interFoam reactingTwoPhaseEulerFoam twoPhaseEulerFoam multiphaseEulerFoam; do command -v $c >/dev/null 2>&1 && echo "HAS=$c"; done; command -v mpirun >/dev/null 2>&1 && echo "MPI=$(mpirun --version 2>&1 | head -1)"`;
    const r = process.platform === 'win32' ? await run('wsl.exe', ['bash', '-lc', probe], { timeout: 30000 }) : await run('bash', ['-c', probe], { timeout: 30000 });
    const kv = k => (r.out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
    Object.assign(foam, { found: !!kv('VER'), bashrc, version: kv('VER'), root: kv('DIR'), tutorials: kv('TUT'),
      solvers: [...r.out.matchAll(/^HAS=(\S+)/gm)].map(m => m[1]), mpi: kv('MPI') });
  }
  env.openfoam = foam;
  // Python（后处理、RSI、技能包模板都要）
  const pys = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const py of pys) {
    const r = await run(py, ['-c', 'import sys,importlib.util as u;print(sys.version.split()[0]);print(",".join(m for m in ("numpy","scipy","matplotlib","vtk","fitz","PIL","optuna") if u.find_spec(m)))']);
    if (r.ok) { const [v, mods] = r.out.trim().split(/\r?\n/); env.python = { cmd: py, version: v, modules: (mods || '').split(',').filter(Boolean) }; break; }
  }
  // LBM：内置 Python 求解模板（numpy）即可；MFIX：mfixsolver 在 PATH 上才算
  env.lbm = { found: !!env.python?.modules?.includes('numpy'), note: '用技能包里的 numpy LBM 模板，不需要单独安装' };
  const mf = process.platform === 'win32' ? { ok: false } : await run('bash', ['-lc', 'command -v mfixsolver || command -v mfix']);
  env.mfix = { found: mf.ok && !!mf.out.trim(), path: (mf.out || '').trim() };
  return env;
}

// ---------------------------------------------------------------- 官方技能包（agent-skills/skills/*/SKILL.md）
export const PACK_META = {
  'openfoam-case-builder': { title: 'OpenFOAM', tools: /^foam_|^opt_|^post_view$/, defaultOn: true },
  'lbm-case-builder': { title: 'LBM 格子玻尔兹曼', tools: /^lbm_/, defaultOn: true },
  'mfix-case-builder': { title: 'MFIX 颗粒流', tools: /^mfix_/, defaultOn: false },
  'lammps-md-case-builder': { title: 'LAMMPS 分子动力学', tools: null, defaultOn: false },
  'liggghts-dem-case-builder': { title: 'LIGGGHTS 离散元', tools: null, defaultOn: true },
};
function frontmatter(md) {
  // 支持 YAML 的 key: value 和折叠块 key: >- / | 后面的缩进行
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md); const o = {};
  if (!m) return o;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(lines[i]); if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][-+]?$/.test(v)) { const buf = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim()); v = buf.join(v.startsWith('|') ? '\n' : ' '); }
    o[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return o;
}
export async function listPacks(dir, enabled = {}) {
  let ents = []; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const f = path.join(dir, e.name, 'SKILL.md'); if (!exists(f)) continue;
    const md = await fs.readFile(f, 'utf8'); const fm = frontmatter(md); const meta = PACK_META[e.name] || {};
    const files = [];
    for (const sub of ['reference', 'templates']) { try { for (const x of await fs.readdir(path.join(dir, e.name, sub))) files.push(`${sub}/${x}`); } catch {} }
    out.push({ id: e.name, title: meta.title || fm.name || e.name, name: fm.name || e.name, description: fm.description || md.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '',
      enabled: enabled[e.name] ?? meta.defaultOn ?? true, files, official: true });
  }
  return out.sort((a, b) => (b.enabled - a.enabled) || a.title.localeCompare(b.title));
}
export async function readPackFile(dir, id, file) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('技能包名不合法');
  const base = path.resolve(dir, id);
  const target = path.resolve(base, file || 'SKILL.md');
  if (!target.startsWith(base + path.sep)) throw new Error('只能读技能包内的文件');
  const s = await fs.readFile(target, 'utf8');
  return s.length > 24000 ? s.slice(0, 24000) + '\n…（已截断）' : s;
}

// ---------------------------------------------------------------- MCP 客户端（stdio，换行分隔 JSON-RPC 2.0）
export class McpServer {
  constructor(cfg, log = () => {}) { this.cfg = cfg; this.log = log; this.tools = []; this.status = 'stopped'; this.error = ''; this.pending = new Map(); this.seq = 0; this.buf = ''; }
  async start() {
    this.stop();
    const { command, args = [], env = {} } = this.cfg;
    if (!command) throw new Error('缺少启动命令');
    this.status = 'starting'; this.error = '';
    const p = this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && this.pending.has(m.id)) { const cb = this.pending.get(m.id); this.pending.delete(m.id); cb(m); }
      }
    });
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-1500); });
    const fail = msg => { this.status = 'error'; this.error = msg; for (const cb of this.pending.values()) cb({ error: { message: msg } }); this.pending.clear(); };
    p.on('error', e => fail('启动失败：' + e.message));
    p.on('exit', code => { if (this.status !== 'stopped') fail(`进程退出（${code}）${errTail ? '：' + errTail.trim().split('\n').pop() : ''}`); });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'NullFlux', version: '1.0' } }, 20000);
    this.notify('notifications/initialized', {});
    const r = await this.request('tools/list', {}, 20000);
    this.tools = (r.tools || []).map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
    this.status = 'ready';
    return this.tools;
  }
  request(method, params, timeout = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) return reject(new Error('MCP 服务未运行'));
      const id = ++this.seq;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} 超时`)); }, timeout);
      this.pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(m.error.message || 'MCP 错误')) : resolve(m.result || {}); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {} }
  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} });
    const text = (r.content || []).map(c => c.type === 'text' ? c.text : c.type === 'image' ? `[图片 ${c.mimeType || ''}]` : JSON.stringify(c)).join('\n');
    return (r.isError ? '[MCP 工具报错] ' : '') + (text || JSON.stringify(r)).slice(0, 60000);
  }
  stop() { this.status = 'stopped'; try { this.proc?.kill(); } catch {} this.proc = null; }
}
// 工具名：mcp__<服务>__<工具>，只留 [A-Za-z0-9_-]，≤64 字符（OpenAI 兼容接口的限制）
export const mcpToolName = (server, tool) => `mcp__${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, 64);
