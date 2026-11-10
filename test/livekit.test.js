// LiveKit mode: the server hands out the right tokens (no LiveKit server needed for these checks).
const { describe, it, before, after } = require('node:test');
const crypto = require('node:crypto');
const { startServer, join, next, assert } = require('./helpers');

const KEY = 'testkey', SECRET = 'a-long-test-secret-for-livekit-tokens';
// check the signature and return the claims
function readToken(token) {
  const [h, p, sig] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  assert.equal(sig, good, 'token is signed with the API secret');
  return JSON.parse(Buffer.from(p, 'base64url').toString());
}

describe('mesh mode (no LiveKit settings)', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv?.stop());
  it('keeps direct connections and 16 people', async () => {
    const tok = await srv.signup('amel');
    const { room } = (await srv.post('/api/rooms', {}, tok)).body;
    const r = await join(await srv.connect(), { room, name: 'x', token: tok });
    assert.equal(r.media, 'mesh');
    assert.equal(r.lk, undefined);
    assert.match(srv.log(), /directly between browsers \(up to 16/);
  });
});

describe('LiveKit mode', () => {
  let srv, tok, room, teacher, kid, kid2;
  before(async () => {
    // an address nothing listens on: server-side LiveKit calls fail quietly, the class goes on
    srv = await startServer({ env: { LIVEKIT_URL: 'ws://127.0.0.1:9/', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, MAX_CLASS_SIZE: '3' } });
    tok = await srv.signup('amel');
    room = (await srv.post('/api/rooms', {}, tok)).body.room;
  });
  after(() => srv?.stop());

  it('gives each person a token for the class room only', async () => {
    teacher = await srv.connect();
    const r = await join(teacher, { room, name: 'x', token: tok });
    assert.equal(r.media, 'livekit');
    assert.equal(r.lk.url, 'ws://127.0.0.1:9');
    const c = readToken(r.lk.token);
    assert.equal(c.iss, KEY);
    assert.equal(c.sub, teacher.id);
    assert.equal(c.name, 'amel');
    assert.deepEqual(c.video, { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
    assert.ok(c.exp - c.nbf <= 6 * 3600 + 10);
  });

  it('uses MAX_CLASS_SIZE instead of 16', async () => {
    kid = await srv.connect();
    kid2 = await srv.connect();
    assert.ok((await join(kid, { room, name: 'Lina' })).ok);
    assert.ok((await join(kid2, { room, name: 'Sami' })).ok);
    const r = await join(await srv.connect(), { room, name: 'Four' });
    assert.equal(r.error, 'This class is full ({n} people max).');
    assert.equal(r.n, 3);
  });

  it('gives no token while waiting in the waiting room', async () => {
    const t2 = await srv.signup('bob');
    const { room: r2 } = (await srv.post('/api/rooms', {}, t2)).body;
    const owner = await srv.connect();
    await join(owner, { room: r2, name: 'x', token: t2 });
    owner.emit('teacher', { action: 'waiting' });
    await next(owner, 'room-flags');
    const r = await join(await srv.connect(), { room: r2, name: 'Waiting kid' });
    assert.equal(r.inLobby, true);
    assert.equal(r.lk, undefined);
  });

  it('moves people to their group room with new tokens, and back', async () => {
    const t1 = next(kid, 'lk-token'), t2 = next(kid2, 'lk-token');
    let teacherGot = false;
    teacher.once('lk-token', () => { teacherGot = true; });
    teacher.emit('teacher', { action: 'breakout-start', count: 2, assign: { [kid.id]: 0, [kid2.id]: 1 } });
    assert.equal(readToken((await t1).token).video.room, `${room}.g1`);
    assert.equal(readToken((await t2).token).video.room, `${room}.g2`);
    assert.equal(teacherGot, false, 'the teacher stays in the main room, so needs no new token');

    const visit = next(teacher, 'lk-token');
    teacher.emit('teacher', { action: 'breakout-move', target: teacher.id, group: 1 });
    assert.equal(readToken((await visit).token).video.room, `${room}.g2`);

    const back = next(kid, 'lk-token');
    teacher.emit('teacher', { action: 'breakout-end' });
    assert.equal(readToken((await back).token).video.room, room);
    assert.equal((await srv.api('/healthz')).status, 200);
  });
});
