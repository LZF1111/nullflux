// 远程访问（手机 / 局域网）口令鉴权。本机回环地址免口令；其余请求需携带口令：
//   ?token=xxx（首次打开，换成 HttpOnly Cookie 后重定向）/ Cookie cfd_auth / Authorization: Bearer xxx
import crypto from 'crypto';
import fs from 'fs';

export const COOKIE = 'cfd_auth';
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/icon.svg']);

export function isLoopback(addr = '') {
  const a = String(addr).replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

export function isLoopbackHost(host = '') {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).trim());
}

// 优先环境变量；否则读文件；绑定非回环地址且无口令时生成一个并保存（权限 600）
export function loadAccessToken({ env = process.env, file, host }) {
  if (env.CFD_ACCESS_TOKEN) return env.CFD_ACCESS_TOKEN.trim();
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch {}
  if (isLoopbackHost(host)) return '';
  const t = crypto.randomBytes(18).toString('base64url');
  try { fs.writeFileSync(file, t + '\n', { mode: 0o600 }); } catch {}
  return t;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromRequest(req) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = parseCookies(req.headers?.cookie)[COOKIE];
  if (cookie) return cookie;
  try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { return ''; }
}

export function isAuthorized(req, token) {
  if (!token) return true;
  if (isLoopback(req.socket?.remoteAddress)) return true;
  return safeEqual(tokenFromRequest(req), token);
}

export function authMiddleware(getToken) {
  return (req, res, next) => {
    const token = getToken();
    if (!token || isLoopback(req.socket?.remoteAddress)) return next();
    // PWA 清单与图标：浏览器拉取 manifest 时默认不带 Cookie，必须公开（不含任何数据）
    if (PUBLIC_PATHS.has(req.path)) return next();
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams.get('token');
    if (q && safeEqual(q, token)) {
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
      url.searchParams.delete('token');
      return res.redirect(url.pathname + (url.search || ''));
    }
    if (isAuthorized(req, token)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '需要访问口令' });
    res.status(401).type('html').send(LOGIN_HTML);
  };
}

const LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>CFDriver · 登录</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f6f7;color:#111}
form{width:min(340px,88vw);display:flex;flex-direction:column;gap:12px;padding:24px;border-radius:16px;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 4px}p{margin:0;color:#6b6b70;font-size:14px}
input{height:44px;padding:0 12px;border:1px solid #ddd;border-radius:10px;font-size:16px}
button{height:44px;border:0;border-radius:10px;background:#111;color:#fff;font-size:16px;font-weight:600}</style></head>
<body><form method="get" action="/app"><h1>CFDriver</h1><p>远程访问需要口令（服务启动日志里可以看到）。</p>
<label for="t" class="sr">访问口令</label><input id="t" name="token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">进入</button></form></body></html>`;
