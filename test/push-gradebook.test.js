// Notifications (Web Push) and the gradebook.
const { describe, it, before, after } = require('node:test');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer, assert } = require('./helpers');

// A pretend push service: keeps every request, and a browser key pair to read them.
function pushService() {
  const got = [];
  const waiters = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url.includes('gone') ? 410 : 201;
      res.end();
      waiters.splice(0).forEach((w) => w());
    });
  });
  return {
    got,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))),
    close: () => srv.close(),
    // wait until `n` pushes arrived
    until: (n, ms = 3000) => new Promise((resolve, reject) => {
      const check = () => (got.length >= n ? resolve(got) : waiters.push(check));
      setTimeout(() => reject(new Error(`only ${got.length} of ${n} pushes arrived`)), ms);
      check();
    }),
  };
}
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  return { ecdh, p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
// RFC 8291 decryption, as a browser does it
function decrypt(keys, body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const shared = keys.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record padding delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}
function checkVapid(header, serverKey, endpoint) {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, header);
  assert.equal(m[2], serverKey);
  const [h, p, sig] = m[1].split('.');
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).aud, new URL(endpoint).origin);
  const raw = Buffer.from(serverKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
}

describe('notifications and gradebook', () => {
  let srv, ps, port, teach, roster, lina, sami, linaTok, parentTok, serverKey, hwId;
  const pupil = browserKeys(), parent = browserKeys(), teacherKeys = browserKeys();
  const sub = (keys, path) => ({ endpoint: `http://127.0.0.1:${port}/${path}`, keys: { p256dh: keys.p256dh, auth: keys.auth } });

  before(async () => {
    ps = pushService();
    port = await ps.listen();
    srv = await startServer();
    teach = await srv.signup('amel', 'Ms Amel');
    roster = (await srv.post('/api/rosters', { name: 'Year 3' }, teach)).body.id;
    [lina, sami] = (await srv.post(`/api/rosters/${roster}/students`, { names: ['Lina', 'Sami'] }, teach)).body;
    linaTok = (await srv.post('/api/auth/code', { code: lina.code })).body.token;
    parentTok = (await srv.post('/api/auth/code', { code: lina.parentCode })).body.token;
    serverKey = (await srv.api('/api/push/key')).body.key;
  });
  after(() => { ps?.close(); return srv?.stop(); });

  it('only accepts real push services (and localhost while testing)', async () => {
    assert.equal((await srv.post('/api/push/subscribe', { subscription: sub(pupil, 'x') })).status, 401);
    const bad = { endpoint: 'https://evil.example.com/x', keys: { p256dh: pupil.p256dh, auth: pupil.auth } };
    assert.equal((await srv.post('/api/push/subscribe', { subscription: bad }, linaTok)).status, 400);
    assert.equal((await srv.post('/api/push/subscribe', { subscription: sub(pupil, 'lina'), lang: 'fr' }, linaTok)).status, 201);
    assert.equal((await srv.post('/api/push/subscribe', { subscription: sub(parent, 'parent') }, parentTok)).status, 201);
    assert.equal((await srv.post('/api/push/subscribe', { subscription: sub(teacherKeys, 'teacher') }, teach)).status, 201);
  });

  it('tells students and parents about new homework, encrypted and signed', async () => {
    const r = await srv.post('/api/homework', { rosterId: roster, title: 'Fractions', due: '2026-12-01', instructions: '' }, teach);
    hwId = r.body.id;
    const got = await ps.until(2);
    assert.deepEqual(got.map((g) => g.path).sort(), ['/lina', '/parent']);
    const toLina = got.find((g) => g.path === '/lina'), toParent = got.find((g) => g.path === '/parent');
    assert.equal(toLina.headers['content-encoding'], 'aes128gcm');
    checkVapid(toLina.headers.authorization, serverKey, `http://127.0.0.1:${port}/lina`);
    assert.equal(decrypt(pupil, toLina.body).title, 'Nouveau devoir : Fractions');
    assert.equal(decrypt(parent, toParent.body).title, 'New homework for Lina: Fractions');
  });

  it('gradebook: marks typed by the teacher reach the student', async () => {
    ps.got.length = 0;
    let r = await srv.post(`/api/homework/${hwId}/marks/${lina.id}`, { mark: '15/20' }, teach, 'PUT');
    assert.equal(r.status, 200);
    const got = await ps.until(2);
    assert.equal(decrypt(pupil, got.find((g) => g.path === '/lina').body).body, 'Note : 15/20');
    r = await srv.api(`/api/rosters/${roster}/gradebook`, {}, teach);
    assert.deepEqual(r.body.homework.map((h) => h.title), ['Fractions']);
    assert.deepEqual(r.body.students.map((s) => [s.name, s.cells[0].mark]), [['Lina', '15/20'], ['Sami', '']]);
    // students cannot read it, and Lina now sees her mark
    assert.equal((await srv.api(`/api/rosters/${roster}/gradebook`, {}, linaTok)).status, 401);
    const mine = (await srv.api('/api/homework', {}, linaTok)).body;
    assert.equal(mine[0].mark, '15/20');
    // an empty mark takes it away
    r = await srv.post(`/api/homework/${hwId}/marks/${lina.id}`, { mark: '' }, teach, 'PUT');
    assert.equal(r.body.markedAt, null);
    assert.equal((await srv.post(`/api/homework/${hwId}/marks/${sami.id}x`, { mark: '1' }, teach, 'PUT')).status, 404);
  });

  it('reminds the class a few minutes before it starts, once', async () => {
    ps.got.length = 0;
    const r = await srv.post('/api/courses', { title: 'Reading', date: '2026-12-02', start: '09:00', end: '09:45', rosterId: roster }, teach);
    assert.equal(r.status, 201);
    const now = new Date('2026-12-02T08:56:00').getTime(); // server and test share a time zone
    await srv.post('/api/test/reminders', { now });
    const got = await ps.until(3);
    assert.deepEqual(got.map((g) => g.path).sort(), ['/lina', '/parent', '/teacher']);
    const msg = decrypt(pupil, got.find((g) => g.path === '/lina').body);
    assert.equal(msg.title, 'Reading commence dans 4 minutes');
    assert.equal(msg.url, '/#/room/' + r.body[0].room);
    await srv.post('/api/test/reminders', { now: now + 60e3 });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(ps.got.length, 3, 'not sent twice');
  });

  it('forgets subscriptions the push service says are gone', async () => {
    const k = browserKeys();
    await srv.post('/api/push/subscribe', { subscription: sub(k, 'gone') }, linaTok);
    ps.got.length = 0;
    await srv.post('/api/homework', { rosterId: roster, title: 'Poem', due: '2026-12-03', instructions: '' }, teach);
    await ps.until(3);
    ps.got.length = 0;
    await srv.post('/api/homework', { rosterId: roster, title: 'Map', due: '2026-12-04', instructions: '' }, teach);
    await ps.until(2);
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(!ps.got.some((g) => g.path === '/gone'));
  });
});
