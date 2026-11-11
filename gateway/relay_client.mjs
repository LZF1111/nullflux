#!/usr/bin/env node
// CFDriver 出网助手：在你自己的电脑上运行，让服务器上你的 CFDriver 通过你这台电脑的网络访问模型 API。
// 只需要 Node.js 22+（https://nodejs.org）。运行：  node cfdriver-net-helper.mjs
// 关掉这个窗口就断开；服务器上的 CFDriver 会改回直连。
// 安全：只替你的账号转发；不代为连接你电脑本机和内网地址（127.x / 10.x / 172.16–31.x / 192.168.x）。
import net from 'node:net';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';

const URL_ = process.env.CFD_GW || '__GW_URL__';
const TOKEN = process.env.CFD_TOKEN || '__GW_TOKEN__';
const F = { OPEN: 1, DATA: 2, CLOSE: 3, OK: 4, FAIL: 5 };
const frame = (t, id, p = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(id, 1);
  return Buffer.concat([h, Buffer.isBuffer(p) ? p : Buffer.from(p)]);
};
const privateIp = ip => {
  const v = ip.replace(/^::ffff:/i, '');
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v) || v === '::1' || /^f[cd]/i.test(v) || /^fe80/i.test(v);
};

// WebSocket：Node 22+ 自带；更老的版本需要 ws 包
let WS = globalThis.WebSocket;
if (!WS) {
  try { WS = createRequire(import.meta.url)('ws'); }
  catch (e) { console.error('需要 Node.js 22 以上（或先在同目录 npm i ws）'); process.exit(1); }
}

let opened = 0, bytes = 0, backoff = 1000;
function connect() {
  const ws = new WS(`${URL_}?t=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  const streams = new Map();
  const send = b => { try { ws.send(b); } catch (e) { /* 已断开 */ } };
  ws.onopen = () => {
    backoff = 1000;
    console.log(`[${new Date().toLocaleTimeString()}] 已连上 CFDriver 服务器，开始代为联网（关掉窗口即停止）`);
  };
  ws.onmessage = async ev => {
    const buf = Buffer.from(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data);
    const t = buf[0], id = buf.readUInt32BE(1), p = buf.subarray(5);
    if (t === F.OPEN) {
      let host, port;
      try { ({ host, port } = JSON.parse(p.toString())); } catch (e) { send(frame(F.FAIL, id, 'bad request')); return; }
      try {
 const ip = net.isIP(host) ? host : (await dns.lookup(host)).address;
        if (privateIp(ip)) { send(frame(F.FAIL, id, `不代为连接内网/本机地址 ${host}`)); return; }
 const s = net.connect(port, ip);
 streams.set(id, s);
 s.setTimeout(15000, () => { if (s.connecting) s.destroy(new Error('连接超时')); else s.setTimeout(0); });
 s.on('connect', () => { opened++; console.log(`  → ${host}:${port}`); send(frame(F.OK, id)); });
 s.on('data', d => { bytes += d.length; send(frame(F.DATA, id, d)); });
        s.on('error', e => { const wasConnecting = s.connecting; if (streams.delete(id)) send(frame(wasConnecting ? F.FAIL : F.CLOSE, id, e.message)); });
        s.on('close', () => { if (streams.delete(id)) send(frame(F.CLOSE, id)); });
      } catch (e) { send(frame(F.FAIL, id, e.message)); }
    } else if (t === F.DATA) {
      const s = streams.get(id); if (s) s.write(p);
    } else if (t === F.CLOSE) {
      const s = streams.get(id); streams.delete(id); if (s) s.end();
    }
  };
  ws.onclose = ev => {
    for (const s of streams.values()) s.destroy();
    streams.clear();
    if (ev.code === 4000) { console.log('另一个出网助手已接管，本窗口退出'); process.exit(0); }
    console.log(`连接断开（${ev.code || ''}），${Math.round(backoff / 1000)} 秒后重连…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => { /* onclose 会接着触发并重连 */ };
}
console.log('CFDriver 出网助手\n服务器：' + URL_.replace(/\/gw\/relay$/, ''));
connect();
setInterval(() => { if (opened) console.log(`  已转发 ${opened} 个连接，${(bytes / 1048576).toFixed(1)} MB`); }, 600000);
