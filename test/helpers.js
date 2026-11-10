// Test helpers: start a real Cartable server on a free port with an empty data folder,
// and talk to it over HTTP and Socket.IO like the browser does.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

async function startServer({ env = {}, seed = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartable-test-'));
  for (const [name, content] of Object.entries(seed)) fs.writeFileSync(path.join(dataDir, name), content);
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (/^(LIVEKIT_|TURN_|CODE_SECRET|ATTENDANCE_DAYS|MAX_CLASS_SIZE)/.test(k)) delete clean[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...clean, PORT: '0', DATA_DIR: dataDir, TEACHER_CODE: 'teach', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${log}`)), 15000);
    child.stdout.on('data', (d) => {
      log += d;
      const m = log.match(/running on http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}\n${log}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];
  return {
    base, dataDir,
    log: () => log,
    ...client(base, sockets),
    async stop() {
      sockets.forEach((s) => s.disconnect());
      child.kill();
      if (child.exitCode === null) await once(child, 'exit');
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function client(base, sockets) {
  const api = async (p, opts = {}, token) => {
    const res = await fetch(base + p, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const post = (p, body, token, method = 'POST') => api(p, { method, body: JSON.stringify(body) }, token);
  const upload = (p, name, body, token, type = 'application/pdf') =>
    api(p, { method: 'POST', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body }, token);
  const connect = () => new Promise((resolve) => {
    const s = io(base, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
  });
  const signup = async (username, name = username) => {
    const r = await post('/api/auth/signup', { name, username, password: 'longenough1', schoolCode: 'teach' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.token;
  };
  return { api, post, upload, connect, signup };
}

const join = (s, payload) => new Promise((resolve) => s.emit('join', payload, resolve));
const emitAck = (s, ev, data) => new Promise((resolve) => s.emit(ev, data, resolve));
const next = (s, ev, ms = 2000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('TIMEOUT'), ms);
  s.once(ev, (d) => { clearTimeout(timer); resolve(d); });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

module.exports = { startServer, join, emitAck, next, wait, today, assert };
