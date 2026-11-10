// Editing classes, the waiting room, whiteboard shapes/text/undo and backgrounds.
const { describe, it, before, after } = require('node:test');
const { startServer, join, next, wait, assert } = require('./helpers');

describe('classroom basics', () => {
  let srv, tok, tokB, w1, w2, w3, room, teacher, kid, kid2;
  before(async () => {
    srv = await startServer();
    tok = await srv.signup('amel', 'Ms Amel');
    tokB = await srv.signup('bob', 'Mr Bob');
  });
  after(() => srv?.stop());

  it('edits one day or every week of a class', async () => {
    let r = await srv.post('/api/courses', { title: 'Maths', date: '2026-11-20', start: '09:00', end: '10:00', repeatWeeks: 3, waitingRoom: true }, tok);
    [w1, w2, w3] = r.body;
    room = w1.room;
    assert.equal(w1.waitingRoom, true);
    r = await srv.post(`/api/courses/${w2.id}`, { title: 'Maths (moved)', date: '2026-11-28', start: '10:00', end: '11:00', color: 'green', waitingRoom: false }, tok, 'PATCH');
    assert.equal(r.status, 200);
    let list = (await srv.api('/api/courses', {}, tok)).body;
    const c2 = list.find((c) => c.id === w2.id), c1 = list.find((c) => c.id === w1.id);
    assert.equal(c2.date, '2026-11-28');
    assert.equal(c2.waitingRoom, false);
    assert.equal(c1.title, 'Maths');
    await srv.post(`/api/courses/${w1.id}?series=1`, { title: 'Maths all', date: '2030-01-01', start: '08:00', end: '08:45', waitingRoom: true }, tok, 'PATCH');
    list = (await srv.api('/api/courses', {}, tok)).body;
    assert.ok(list.every((c) => c.title === 'Maths all' && c.start === '08:00'));
    assert.equal(list.find((c) => c.id === w3.id).date, w3.date, 'each week keeps its date');
    assert.equal((await srv.post(`/api/courses/${w1.id}`, { title: 'X', start: '10:00', end: '09:00' }, tok, 'PATCH')).status, 400);
    assert.equal((await srv.post(`/api/courses/${w1.id}`, { title: 'Hack', start: '10:00', end: '11:00' }, tokB, 'PATCH')).status, 404);
  });

  it('puts students in the waiting room until the teacher lets them in', async () => {
    kid = await srv.connect();
    let r = await join(kid, { room, name: 'Lina' });
    assert.equal(r.inLobby, true);
    assert.ok(!r.ok);
    teacher = await srv.connect();
    r = await join(teacher, { room, name: 'x', token: tok });
    assert.ok(r.ok && !r.inLobby, 'the teacher never waits');
    assert.deepEqual(r.lobby.map((p) => p.name), ['Lina']);
    kid2 = await srv.connect();
    const lobbyMsg = next(teacher, 'lobby');
    await join(kid2, { room, name: 'Sami' });
    assert.equal((await lobbyMsg).length, 2);
    const admitted = next(kid, 'admitted');
    teacher.emit('teacher', { action: 'admit', target: kid.id });
    const a = await admitted;
    assert.equal(a.role, 'student');
    assert.equal(a.peers.length, 1);
    const denied = next(kid2, 'denied');
    teacher.emit('teacher', { action: 'deny', target: kid2.id });
    assert.notEqual(await denied, 'TIMEOUT');
    const kid3 = await srv.connect();
    await join(kid3, { room, name: 'Yasmine' });
    const adm3 = next(kid3, 'admitted'), flags = next(teacher, 'room-flags');
    teacher.emit('teacher', { action: 'waiting' });
    assert.ok((await adm3).ok, 'turning the waiting room off lets everyone in');
    assert.equal((await flags).waiting, false);
  });

  it('relays shapes and text, drops bad items, undoes whole strokes', async () => {
    const got = [];
    teacher.on('draw', (d) => got.push(d));
    kid.emit('draw', { id: 'p1', c: '#2F6FED', w: 4, pts: [[1, 1], [5, 5]] });
    kid.emit('draw', { id: 'p1', c: '#2F6FED', w: 4, pts: [[5, 5], [9, 9]] });
    kid.emit('draw', { id: 'r1', k: 'rect', c: '#2F6FED', w: 4, pts: [[10, 10], [50, 60]] });
    kid.emit('draw', { id: 'r2', k: 'rect', c: '#2F6FED', w: 4, pts: [[10, 10]] });
    kid.emit('draw', { id: 't1', k: 'text', c: '#1B2A4A', s: 999, pts: [[100, 100]], txt: ' 2 + 2 = 4\n ' });
    kid.emit('draw', { id: 't2', k: 'text', c: '#1B2A4A', s: 30, pts: [[100, 100]], txt: '   ' });
    kid.emit('draw', { id: 'z1', k: 'star', c: '#1B2A4A', w: 4, pts: [[1, 1], [2, 2]] });
    kid.emit('draw', { id: 'no id!', c: '#1B2A4A', w: 4, pts: [[1, 1], [2, 2]] });
    await wait(300);
    assert.deepEqual(got.map((g) => g.id), ['p1', 'p1', 'r1', 't1']);
    assert.equal(got[3].txt, '2 + 2 = 4');
    assert.equal(got[3].s, 120);
    const removed = next(teacher, 'board-remove');
    teacher.emit('undo', 'p1'); // not the teacher's stroke: ignored
    kid.emit('undo', 'p1');
    assert.equal(await removed, 'p1');
    const r = await join(await srv.connect(), { room, name: 'Late' });
    assert.deepEqual(r.strokes.map((s) => s.id), ['r1', 't1']);
  });

  it('lets only the class teacher set a JPEG background', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)]);
    const put = (body, t) => srv.api(`/api/rooms/${room}/background`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body }, t);
    assert.equal((await put(jpeg, tokB)).status, 403);
    assert.equal((await put(Buffer.from('not an image at all'), tok)).status, 400);
    const bg = next(kid, 'board-bg');
    const r = await put(jpeg, tok);
    assert.equal((await bg).v, r.body.v);
    assert.ok((await srv.api(`/api/rooms/${room}/background?v=${r.body.v}`)).body.equals(jpeg));
    assert.equal((await put(Buffer.concat([jpeg, Buffer.alloc(4 * 1024 * 1024)]), tok)).status, 413);
    const off = next(kid, 'board-bg');
    await srv.api(`/api/rooms/${room}/background`, { method: 'DELETE' }, tok);
    assert.equal((await off).v, 0);
    assert.equal((await srv.api('/api/rooms/abc-def-ghj/background')).status, 404);
  });
});
