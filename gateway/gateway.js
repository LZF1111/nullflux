#!/usr/bin/env node
// CFDriver 多用户网关：账号登录 → 每个用户一个独立沙箱里的 CFDriver 实例 → 反向代理（HTTP + WebSocket）。
//
//   node gateway.js serve [--port 5310]       启动网关（0.0.0.0）
//   node gateway.js adduser <名字>            新建账号，打印初始密码
//   node gateway.js passwd <名字>             重置密码
//   node gateway.js disable|enable <名字>     停用 / 启用账号（停用会停掉实例）
//   node gateway.js list                      账号列表
//
// 隔离：每个实例跑在 bwrap 里——独立 PID / 网络命名空间（只有 lo），只看得见自己的目录，
// OpenFOAM 与 Python 库只读；出网走网关的代理，代理拒绝回环和本机地址（防止连到本机其它服务）。
// 每个用户的 API 设置存在自己目录的 settings.json 里，互相不可见。
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { WebSocketServer } = createRequire(import.meta.url)(path.resolve(HERE, '..', 'node_modules', 'ws'));
const WSS = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });
const DATA = process.env.GW_DATA || path.join(os.homedir(), 'cfdriver-gw');
const APP_SRC = process.env.GW_APP_SRC || path.resolve(HERE, '..');
const CPUS = process.env.GW_CPUS || '';                     // 例如 88-95；空 = 不绑核
const FOAM_BASH = process.env.GW_FOAM_BASH || '';
const PYLIB = process.env.GW_PYLIB || '';                   // 例如 ~/.local/lib/python3.10/site-packages
const EXTRA_RO = (process.env.GW_RO || '').split(':').filter(Boolean);   // 额外只读挂载（OpenFOAM 安装目录等）
const MAX_USERS_RUNNING = +(process.env.GW_MAX_RUNNING || 12);
const USERS_FILE = path.join(DATA, 'users.json');
const NAME_RE = /^[a-z][a-z0-9_-]{1,23}$/;

fs.mkdirSync(path.join(DATA, 'users'), { recursive: true, mode: 0o700 });
const SECRET = (() => {
  const f = path.join(DATA, 'secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, s, { mode: 0o600 }); return s;
})();

// ------------------------------------------------------------------ 账号
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } };
const saveUsers = u => { fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(u, null, 2), { mode: 0o600 }); fs.renameSync(USERS_FILE + '.tmp', USERS_FILE); };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const newPw = () => crypto.randomBytes(9).toString('base64url');
function checkPw(name, pw) {
  const u = loadUsers()[name];
  if (!u || u.disabled) { hashPw(pw, 'x'); return false; }
  const h = Buffer.from(hashPw(pw, u.salt), 'hex'), w = Buffer.from(u.hash, 'hex');
  return h.length === w.length && crypto.timingSafeEqual(h, w);
}
function setPw(name, pw) { const all = loadUsers(); const salt = crypto.randomBytes(16).toString('hex'); all[name] = { ...(all[name] || { created: new Date().toISOString() }), salt, hash: hashPw(pw, salt) }; saveUsers(all); }

// ------------------------------------------------------------------ 会话 cookie：名字.过期.签名
const COOKIE = 'cfdgw';
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeSession = name => { const v = `${name}.${Date.now() + 30 * 864e5}`; return `${v}.${sign(v)}`; };
function sessionUser(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.'); if (parts.length !== 3) return null;
  const [name, exp, sig] = parts, v = `${name}.${exp}`;
  const a = Buffer.from(sig), b = Buffer.from(sign(v));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b) || +exp < Date.now()) return null;
  const u = loadUsers()[name];
  return u && !u.disabled ? name : null;
}
const relayToken = name => { const u = loadUsers()[name]; return `${name}.${sign('relay:' + name + ':' + (u?.salt || ''))}`; };
function relayUser(tok) {
  const [name, sig] = String(tok || '').split('.'); const u = loadUsers()[name];
  if (!u || u.disabled || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign('relay:' + name + ':' + u.salt));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? name : null;
}
const stripGwCookie = c => (c || '').split(/;\s*/).filter(x => x && !x.startsWith(COOKIE + '=')).join('; ');

// ------------------------------------------------------------------ 出网代理（CONNECT + 绝对 URL 的 HTTP）
// 出口有两种：服务器自己的网络（直连）；访客电脑上运行的「出网助手」（/gw/relay WebSocket 反向连进来）。
// 访客的助手在线时优先走助手：服务器所在网络要上网认证，访客自己的电脑一般已经认证过。
const RELAYS = new Map();   // user -> { ws, streams: Map<id, sock>, seq, since, host }
const LOCAL_ADDRS = new Set(['0.0.0.0', '::', '::1']);
for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) LOCAL_ADDRS.add(a.address);
function forbidden(ip) {
  if (LOCAL_ADDRS.has(ip)) return true;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (LOCAL_ADDRS.has(v4) || /^127\./.test(v4) || /^169\.254\./.test(v4) || /^0\./.test(v4)) return true;
  if (/^172\.17\./.test(ip)) return true;                    // docker0
  return false;
}
async function resolveAllowed(host) {
  const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
  if (forbidden(ip)) throw new Error(`不允许连接本机地址 ${host}`);
  return ip;
}
function egressServer(user, sockPath) {
  const log = m => fs.appendFile(path.join(DATA, 'users', user, 'egress.log'), `${new Date().toISOString()} ${m}\n`, () => {});
  const srv = http.createServer(async (req, res) => {
    // 普通 HTTP 代理请求：GET http://host:port/path
    let u; try { u = new URL(req.url); } catch { res.writeHead(400).end('bad proxy request'); return; }
    try {
      const ip = await resolveAllowed(u.hostname);
      log(`HTTP ${u.hostname}:${u.port || 80}`);
      const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host }, timeout: 600000 }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end('proxy: ' + e.message); });
      req.pipe(up);
    } catch (e) { log(`DENY ${u.hostname} ${e.message}`); res.writeHead(403).end(e.message); }
  });
  srv.on('connect', async (req, sock, head) => {
    const [host, port = '443'] = req.url.split(/:(?=\d+$)/);
    const relay = RELAYS.get(user);
    if (relay) {
      // 访客电脑代为连接：名字原样交给助手解析，服务器这边不解析也不连
      if (/^(localhost|127\.|0\.|169\.254\.|\[?::1\]?$)/i.test(host) || LOCAL_ADDRS.has(host)) { log(`DENY(relay) ${host}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      log(`RELAY ${host}:${port}`);
      relayOpen(relay, host, +port, sock, head);
      return;
    }
    try {
      const ip = await resolveAllowed(host);
      log(`CONNECT ${host}:${port}`);
      const up = net.connect(+port, ip, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); });
      up.setTimeout(15000, () => { if (up.connecting) up.destroy(new Error('连接超时（服务器可能没有外网）')); else up.setTimeout(0); });
      up.on('error', e => { sock.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${e.message}`); });
      sock.on('error', () => up.destroy());
    } catch (e) { log(`DENY ${host} ${e.message}`); sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${e.message}`); }
  });
  try { fs.unlinkSync(sockPath); } catch {}
  srv.listen(sockPath);
  return srv;
}

// ---- 出网助手：一条 WebSocket 上复用多条 TCP 流 ----
// 帧（二进制）：[1 字节类型][4 字节流 id][负载]；1=打开(JSON {host,port}) 2=数据 3=关闭 4=打开成功 5=打开失败(负载=原因)
const F = { OPEN: 1, DATA: 2, CLOSE: 3, OK: 4, FAIL: 5 };
const frame = (t, id, payload = Buffer.alloc(0)) => { const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(id, 1); return Buffer.concat([h, Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]); };
function relayOpen(relay, host, port, sock, head) {
  const id = ++relay.seq;
  relay.streams.set(id, { sock, head, open: false });
  relay.ws.send(frame(F.OPEN, id, JSON.stringify({ host, port })));
  sock.on('data', d => { const st = relay.streams.get(id); if (st && st.open) relay.ws.send(frame(F.DATA, id, d)); });
  const close = () => { if (relay.streams.delete(id)) { try { relay.ws.send(frame(F.CLOSE, id)); } catch (e) { /* 助手已断 */ } } };
  sock.on('close', close); sock.on('error', close);
  setTimeout(() => {
    const st = relay.streams.get(id);
    if (st && !st.open) { relay.streams.delete(id); sock.end('HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n出网助手 20 秒没有连上目标'); }
  }, 20000);
}
function relayMessage(relay, buf) {
  const t = buf[0], id = buf.readUInt32BE(1), p = buf.subarray(5), st = relay.streams.get(id);
  if (!st) return;
  if (t === F.OK) { st.open = true; st.sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (st.head && st.head.length) relay.ws.send(frame(F.DATA, id, st.head)); }
  else if (t === F.FAIL) { relay.streams.delete(id); st.sock.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n出网助手连不上：${p.toString()}`); }
  else if (t === F.DATA) st.sock.write(p);
  else if (t === F.CLOSE) { relay.streams.delete(id); st.sock.end(); }
}
function relayAttach(user, ws, req) {
  const old = RELAYS.get(user);
  if (old) { try { old.ws.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
  const relay = { ws, streams: new Map(), seq: 0, since: Date.now(), host: req.socket.remoteAddress };
  RELAYS.set(user, relay);
  console.log(`[gw] ${user} 出网助手已连接（${relay.host}）`);
  ws.on('message', (d, isBinary) => { if (!isBinary) return; try { relayMessage(relay, Buffer.from(d)); } catch (e) { /* 坏帧丢掉 */ } });
  const bye = () => {
    if (RELAYS.get(user) === relay) RELAYS.delete(user);
    for (const st of relay.streams.values()) st.sock.destroy();
    relay.streams.clear();
    console.log(`[gw] ${user} 出网助手断开`);
  };
  ws.on('close', bye); ws.on('error', bye);
  const ping = setInterval(() => { try { ws.ping(); } catch (e) { /* ignore */ } }, 25000);
  ws.on('close', () => clearInterval(ping));
}

// ------------------------------------------------------------------ 实例
const INST = new Map();   // name -> { proc, egress, ready: Promise, state, last }
const SYNC_EXCLUDES = ['node_modules', 'settings.json', 'copilot.json', 'tasks/', 'skills/', '.nullflux/', 'server.log', '__pycache__/', 'backup_*/', '*.bak*', '.access_token', '.env', 'rsi/', 'rsi_stage/', 'test/', 'gateway/', '.git/'];
function syncApp(appDir, first) {
  const ex = SYNC_EXCLUDES.filter(x => !(first && x === 'skills/')).flatMap(x => ['--exclude', x]);
  const r = spawnSync('rsync', ['-a', '--delete', ...ex, APP_SRC + '/', appDir + '/'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('同步程序失败：' + r.stderr);
}
function unixGet(sock, p, timeout = 3000) {
  return new Promise(resolve => {
    const r = http.get({ socketPath: sock, path: p, timeout }, res => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve(0)); r.on('timeout', () => { r.destroy(); resolve(0); });
  });
}
// 沙箱参数：实例和 exec 管理命令共用同一份，保证测出来的就是实例真实的隔离
function bwrapArgs(name, home, argv) {
  const ro = (a, b = a) => ['--ro-bind', a, b];
  return [
    '--unshare-all', '--die-with-parent', '--new-session', '--hostname', 'cfdriver',
    ...ro('/usr'), '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    ...ro('/etc'), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm', '--dir', '/var', '--tmpfs', '/var/tmp',
    ...EXTRA_RO.flatMap(p => ro(p)),
    ...(PYLIB ? ro(PYLIB, '/opt/pylib') : []),
    '--bind', home, '/home/cfd',
    ...ro(path.join(APP_SRC, 'node_modules'), '/home/cfd/app/node_modules'),
    ...ro(path.join(HERE, 'sandbox_init.mjs'), '/opt/sandbox_init.mjs'),
    '--chdir', '/home/cfd/workspace', '--clearenv',
    '--setenv', 'HOME', '/home/cfd', '--setenv', 'USER', 'cfd', '--setenv', 'LOGNAME', 'cfd', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
    '--setenv', 'WORKSPACE_DIR', '/home/cfd/workspace', '--setenv', 'CFD_GUEST', name,
    '--setenv', 'CFD_EGRESS_PROXY', '1', '--setenv', 'MPLCONFIGDIR', '/tmp/mpl',
    ...['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(k => ['--setenv', k, 'http://127.0.0.1:3128']),
    ...['NO_PROXY', 'no_proxy'].flatMap(k => ['--setenv', k, 'localhost,127.0.0.1,::1']),
    ...(PYLIB ? ['--setenv', 'PYTHONPATH', '/opt/pylib'] : []),
    ...(FOAM_BASH ? ['--setenv', 'FOAM_BASH', FOAM_BASH] : []),
    ...argv,
  ];
}
async function startInstance(name) {
  const running = [...INST.values()].filter(i => i.state !== 'stopped').length;
  if (running >= MAX_USERS_RUNNING) throw new Error('同时在线的工作区已满，请稍后再试');
  const base = path.join(DATA, 'users', name), home = path.join(base, 'home'), app = path.join(home, 'app'), run = path.join(home, '.run');
  const first = !fs.existsSync(app);
  for (const d of [home, app, run, path.join(home, 'workspace'), path.join(app, 'node_modules')]) fs.mkdirSync(d, { recursive: true });
  syncApp(app, first);
  fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
  const sf = path.join(app, 'settings.json');
  if (!fs.existsSync(sf)) fs.writeFileSync(sf, JSON.stringify({ workspace: '/home/cfd/workspace', provider: 'openai', baseUrl: '', model: '', apiKey: '' }, null, 2), { mode: 0o600 });
  const egress = egressServer(name, path.join(run, 'egress.sock'));
  const args = bwrapArgs(name, home, ['/usr/bin/node', '/opt/sandbox_init.mjs']);
  const cmd = CPUS ? ['taskset', ['-c', CPUS, 'nice', '-n', '5', 'bwrap', ...args]] : ['nice', ['-n', '5', 'bwrap', ...args]];
  const out = fs.openSync(path.join(base, 'instance.log'), 'a');
  const proc = spawn(cmd[0], cmd[1], { stdio: ['ignore', out, out] });
  const inst = { proc, egress, state: 'starting', last: Date.now(), sock: path.join(run, 'web.sock') };
  INST.set(name, inst);
  proc.on('exit', code => { inst.state = 'stopped'; egress.close(); console.log(`[gw] ${name} 实例退出 (${code})`); });
  inst.ready = (async () => {
    for (let i = 0; i < 180; i++) {
      if (inst.state === 'stopped') throw new Error('工作区启动失败，请联系管理员（instance.log）');
      if (await unixGet(inst.sock, '/api/config') === 200) { inst.state = 'ready'; console.log(`[gw] ${name} 就绪`); return; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('工作区启动超时');
  })();
  inst.ready.catch(() => {});
  return inst;
}
async function ensure(name) {
  let inst = INST.get(name);
  if (!inst || inst.state === 'stopped') inst = await startInstance(name);
  inst.last = Date.now();
  return inst;
}
function stopInstance(name) { const i = INST.get(name); if (i && i.state !== 'stopped') { try { i.proc.kill('SIGTERM'); } catch {} } }

// ------------------------------------------------------------------ 页面
const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f6f7;color:#111}
.card{width:min(360px,88vw);display:flex;flex-direction:column;gap:12px;padding:28px 24px;border-radius:16px;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:22px;margin:0}p{margin:0;color:#6b6b70;font-size:14px;line-height:1.6}label{font-size:13px;color:#444;display:flex;flex-direction:column;gap:6px}
input{height:42px;padding:0 12px;border:1px solid #ddd;border-radius:10px;font-size:16px}button{height:44px;border:0;border-radius:10px;background:#111;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#dc2626}.spin{width:28px;height:28px;border:3px solid #ddd;border-top-color:#111;border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body>${body}</body></html>`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const loginPage = (err = '', name = '') => page('CFDriver · 登录', `<form class="card" method="post" action="/gw/login"><h1>CFDriver</h1><p>面向反应器的 CFD 智能体。账号由管理员分配。</p>
${err ? `<p class="err">${esc(err)}</p>` : ''}<label>账号<input name="u" value="${esc(name)}" autocomplete="username" required autofocus></label>
<label>密码<input name="p" type="password" autocomplete="current-password" required></label><button>登录</button></form>`);
const startingPage = () => page('正在准备工作区', `<div class="card" style="align-items:center;text-align:center"><div class="spin"></div><h1>正在准备你的工作区</h1><p>首次打开约需十几秒，页面会自动刷新。</p></div><script>setTimeout(()=>location.reload(),2500)</script>`);

const FAILS = new Map();
function rateLimited(ip) { const f = FAILS.get(ip); return f && f.n >= 8 && Date.now() - f.t < 10 * 60e3; }
function noteFail(ip) { const f = FAILS.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60e3) f.n = 0; f.n++; f.t = Date.now(); FAILS.set(ip, f); }
const readBody = req => new Promise(r => { let s = ''; req.on('data', d => { s += d; if (s.length > 4096) req.destroy(); }); req.on('end', () => r(Object.fromEntries(new URLSearchParams(s)))); });
const isSecure = req => req.headers['x-forwarded-proto'] === 'https';

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '';
  if (url.pathname === '/gw/login' && req.method === 'POST') {
    if (rateLimited(ip)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage('尝试次数太多，请 10 分钟后再试')); return; }
    const b = await readBody(req); const name = String(b.u || '').trim().toLowerCase();
    if (!NAME_RE.test(name) || !checkPw(name, String(b.p || ''))) { noteFail(ip); res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage('账号或密码不对', name)); return; }
    FAILS.delete(ip);
    res.writeHead(303, { Location: '/app', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(makeSession(name))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${isSecure(req) ? '; Secure' : ''}` }).end();
    ensure(name).catch(() => {});
    return;
  }
  if (url.pathname === '/gw/logout') { res.writeHead(303, { Location: '/gw/login', 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` }).end(); return; }
  if (url.pathname === '/gw/login') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage()); return; }
  const user = sessionUser(req);
  if (!user) {
    if (url.pathname.startsWith('/api/')) res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"请先登录"}');
    else res.writeHead(303, { Location: '/gw/login' }).end();
    return;
  }
  if (url.pathname === '/gw/me') { const r = RELAYS.get(user); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ user, relay: r ? { since: r.since, host: r.host, streams: r.streams.size } : null })); return; }
  if (url.pathname === '/gw/relay.mjs') {
    const host = req.headers.host || '';
    const src = fs.readFileSync(path.join(HERE, 'relay_client.mjs'), 'utf8').replace('__GW_URL__', `ws://${host}/gw/relay`).replace('__GW_TOKEN__', relayToken(user));
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Disposition': 'attachment; filename="cfdriver-net-helper.mjs"', 'Cache-Control': 'no-store' }).end(src); return;
  }
  let inst;
  try { inst = await ensure(user); } catch (e) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end(e.message); return; }
  if (inst.state !== 'ready') {
    const nav = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (nav) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(startingPage()); return; }
    try { await inst.ready; } catch (e) { res.writeHead(503).end(e.message); return; }
  }
  const headers = { ...req.headers, host: '127.0.0.1:5300' };
  headers.cookie = stripGwCookie(headers.cookie); if (!headers.cookie) delete headers.cookie;
  delete headers.authorization;
  const up = http.request({ socketPath: inst.sock, method: req.method, path: req.url, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', e => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('工作区连接失败：' + e.message); });
  req.pipe(up);
}
async function onUpgrade(req, sock, head) {
  if (req.url.startsWith('/gw/relay')) {
    const tok = new URL(req.url, 'http://x').searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = relayUser(tok);
    if (!user) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    WSS.handleUpgrade(req, sock, head, ws => relayAttach(user, ws, req));
    return;
  }
  const user = sessionUser(req);
  if (!user) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  let inst;
  try { inst = await ensure(user); await inst.ready; } catch { sock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  const up = net.connect(inst.sock, () => {
    const h = { ...req.headers, host: '127.0.0.1:5300' }; h.cookie = stripGwCookie(h.cookie); if (!h.cookie) delete h.cookie; delete h.authorization;
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  const end = () => { up.destroy(); sock.destroy(); };
  up.on('error', end); sock.on('error', end);
}

// ------------------------------------------------------------------ CLI
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'serve') {
  const port = +(process.argv[process.argv.indexOf('--port') + 1]) || 5310;
  const srv = http.createServer((q, s) => onRequest(q, s).catch(e => { try { s.writeHead(500).end(e.message); } catch {} }));
  srv.on('upgrade', (q, s, h) => onUpgrade(q, s, h).catch(() => s.destroy()));
  srv.listen(port, '0.0.0.0', () => console.log(`[gw] CFDriver 多用户网关 :${port}  数据 ${DATA}  程序 ${APP_SRC}${CPUS ? '  绑核 ' + CPUS : ''}`));
  const bye = () => { for (const n of INST.keys()) stopInstance(n); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
} else if (cmd === 'adduser' || cmd === 'passwd') {
  const name = String(arg || '').toLowerCase();
  if (!NAME_RE.test(name)) { console.error('名字：小写字母开头，2–24 位字母数字 _ -'); process.exit(1); }
  if (cmd === 'adduser' && loadUsers()[name]) { console.error('已存在；重置密码用 passwd'); process.exit(1); }
  if (cmd === 'passwd' && !loadUsers()[name]) { console.error('没有这个账号'); process.exit(1); }
  const pw = newPw(); setPw(name, pw); console.log(`${name}  密码：${pw}`);
} else if (cmd === 'disable' || cmd === 'enable') {
  const all = loadUsers(); if (!all[arg]) { console.error('没有这个账号'); process.exit(1); }
  all[arg].disabled = cmd === 'disable'; saveUsers(all); console.log(`${arg} 已${cmd === 'disable' ? '停用（重启网关后实例停止）' : '启用'}`);
} else if (cmd === 'exec') {
  // 用和实例完全相同的沙箱跑一条命令（排查问题、做隔离自检）。出网走正在运行的网关的代理
  const name = String(arg || ''); const line = process.argv.slice(4).join(' ');
  const home = path.join(DATA, 'users', name, 'home');
  if (!fs.existsSync(home)) { console.error('这个用户还没有工作区（先登录一次）'); process.exit(1); }
  const args = bwrapArgs(name, home, ['/usr/bin/node', '/opt/sandbox_init.mjs', '--exec', line]);
  const r = CPUS ? spawnSync('taskset', ['-c', CPUS, 'bwrap', ...args], { stdio: 'inherit' }) : spawnSync('bwrap', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (cmd === 'list') {
  for (const [n, u] of Object.entries(loadUsers())) console.log(`${n}\t${u.disabled ? '停用' : '正常'}\t${u.created}`);
} else {
  console.log('用法：node gateway.js serve [--port 5310] | adduser <名字> | passwd <名字> | disable|enable <名字> | list');
}
