// 在 bwrap 沙箱里运行（独立网络命名空间，只有 lo）：
//   ~/.run/web.sock  →  127.0.0.1:5300（本沙箱里的 NullFlux），网关从外面连这个 unix socket
//   127.0.0.1:3128  →  ~/.run/egress.sock（网关的出网代理，网关决定能连哪里）
// 管理用：sandbox_init.mjs --exec "<bash 命令>" 只起出网转发，然后跑命令（网关 exec 子命令用）
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = process.env.HOME;
const RUN = path.join(HOME, '.run');
const pipe = (a, b) => { a.pipe(b); b.pipe(a); const end = () => { a.destroy(); b.destroy(); }; a.on('error', end); b.on('error', end); a.on('close', end); b.on('close', end); };

const egress = net.createServer(c => pipe(c, net.connect(path.join(RUN, 'egress.sock')))).listen(3128, '127.0.0.1');

if (process.argv[2] === '--exec') {
  egress.on('listening', () => {
    const p = spawn('/bin/bash', ['-c', process.argv[3] || 'true'], { stdio: 'inherit' });
    p.on('exit', code => process.exit(code ?? 1));
  });
} else {
  const web = path.join(RUN, 'web.sock');
  try { fs.unlinkSync(web); } catch {}
  net.createServer(c => pipe(c, net.connect(5300, '127.0.0.1'))).listen(web, () => { try { fs.chmodSync(web, 0o600); } catch {} });
  process.chdir(path.join(HOME, 'app'));
  process.argv.push('--host', '127.0.0.1', '--port', '5300');
  await import(path.join(HOME, 'app', 'server.js'));
}
