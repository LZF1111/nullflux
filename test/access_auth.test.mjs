import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLoopback, isAuthorized, loadAccessToken, authMiddleware, COOKIE } from '../access_auth.js';

const req = (addr, { url = '/app', headers = {} } = {}) => ({ socket: { remoteAddress: addr }, url, path: url.split('?')[0], headers });

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true);
  for (const a of ['192.168.0.10', '::ffff:10.0.0.2', '']) assert.equal(isLoopback(a), false);
});

test('remote clients need the token; loopback does not', () => {
  const t = 'secret-token';
  assert.equal(isAuthorized(req('127.0.0.1'), t), true);
  assert.equal(isAuthorized(req('192.168.1.5'), t), false);
  assert.equal(isAuthorized(req('192.168.1.5', { headers: { authorization: 'Bearer secret-token' } }), t), true);
  assert.equal(isAuthorized(req('192.168.1.5', { headers: { cookie: `a=1; ${COOKIE}=secret-token` } }), t), true);
  assert.equal(isAuthorized(req('192.168.1.5', { url: '/?token=secret-token' }), t), true);
  assert.equal(isAuthorized(req('192.168.1.5', { url: '/?token=wrong' }), t), false);
  assert.equal(isAuthorized(req('192.168.1.5'), ''), true);
});

test('token is generated only for non-loopback binds and persisted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfdauth-')), '.access_token');
  assert.equal(loadAccessToken({ env: {}, file, host: '127.0.0.1' }), '');
  const t = loadAccessToken({ env: {}, file, host: '0.0.0.0' });
  assert.ok(t.length >= 20);
  assert.equal(loadAccessToken({ env: {}, file, host: '0.0.0.0' }), t);
  assert.equal(loadAccessToken({ env: { CFD_ACCESS_TOKEN: 'env-t' }, file, host: '0.0.0.0' }), 'env-t');
});

test('middleware: query token sets cookie and redirects; missing token gets 401', () => {
  const mw = authMiddleware(() => 'tok');
  const res = () => ({ headers: {}, code: 200, setHeader(k, v) { this.headers[k] = v; }, redirect(u) { this.redirected = u; },
    status(c) { this.code = c; return this; }, type() { return this; }, send(b) { this.body = b; }, json(b) { this.body = b; } });
  let r = res(), nexted = false;
  mw(req('10.0.0.2', { url: '/app?token=tok&x=1' }), r, () => { nexted = true; });
  assert.equal(r.redirected, '/app?x=1');
  assert.match(r.headers['Set-Cookie'], /cfd_auth=tok; HttpOnly; SameSite=Strict/);
  r = res(); mw(req('10.0.0.2', { url: '/api/config' }), r, () => { nexted = true; });
  assert.equal(r.code, 401);
  assert.equal(nexted, false);
  r = res(); mw(req('127.0.0.1', { url: '/api/config' }), r, () => { nexted = true; });
  assert.equal(nexted, true);
});
