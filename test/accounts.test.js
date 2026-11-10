// Teacher accounts, private class lists, real room codes, input checks, old data import.
const { describe, it, before, after } = require('node:test');
const { startServer, join, wait, assert } = require('./helpers');

const OLD_DB = JSON.stringify({
  courses: [{ id: 'c2997017', series: 'e952babf', room: 'vdz-tau-udk', title: 'Plants and seeds', date: '2026-11-11', start: '10:00', end: '10:45', subject: 'Science', group: 'Year 3', teacher: 'Ms Amel', notes: '', color: 'green' }],
  attendance: { 'vdz-tau-udk': [{ name: 'Lina', role: 'student', at: '2026-11-11T10:01:00.000Z' }] },
});

describe('teacher accounts and private classes', () => {
  let srv, tokA, tokB, bClass;
  before(async () => { srv = await startServer({ env: { TEACHER_CODE: 'school1' }, seed: { 'db.json': OLD_DB } }); });
  after(() => srv?.stop());

  it('nobody can list classes without signing in', async () => {
    const r = await srv.api('/api/courses');
    assert.deepEqual(r.body, []);
  });

  it('checks sign-up details', async () => {
    let r = await srv.post('/api/auth/signup', { name: 'Ms Amel', username: 'amel', password: 'short', schoolCode: 'school1' });
    assert.equal(r.status, 400);
    r = await srv.post('/api/auth/signup', { name: 'Ms Amel', username: 'amel', password: 'longenough1', schoolCode: 'wrong' });
    assert.equal(r.status, 403);
    r = await srv.post('/api/auth/signup', { name: 'Ms Amel', username: 'Amel', password: 'longenough1', schoolCode: 'school1' });
    assert.equal(r.status, 201);
    tokA = r.body.token;
    r = await srv.post('/api/auth/signup', { name: 'Mr Bob', username: 'amel', password: 'longenough2', schoolCode: 'school1' });
    assert.equal(r.status, 409);
    r = await srv.post('/api/auth/signup', { name: 'Mr Bob', username: 'bob', password: 'longenough2', schoolCode: 'school1' });
    tokB = r.body.token;
  });

  it('signs in with a case-insensitive username, refuses a wrong password', async () => {
    let r = await srv.post('/api/auth/login', { username: 'amel', password: 'nope-nope' });
    assert.equal(r.status, 401);
    r = await srv.post('/api/auth/login', { username: 'AMEL', password: 'longenough1' });
    assert.equal(r.body.teacher.name, 'Ms Amel');
  });

  it('imports the old db.json and gives its classes to the first teacher', async () => {
    let r = await srv.api('/api/courses', {}, tokA);
    assert.deepEqual(r.body.map((c) => c.title), ['Plants and seeds']);
    r = await srv.api('/api/courses', {}, tokB);
    assert.deepEqual(r.body, []);
    r = await srv.api('/api/attendance/vdz-tau-udk', {}, tokA);
    assert.equal(r.body[0].name, 'Lina');
  });

  it('students only see classes whose code they know', async () => {
    const r = await srv.api('/api/courses?rooms=vdz-tau-udk,zzz-zzz-zzz,bad');
    assert.deepEqual(r.body.map((c) => c.room), ['vdz-tau-udk']);
    assert.ok(!('teacher_id' in r.body[0]));
  });

  it('teachers manage only their own classes', async () => {
    let r = await srv.post('/api/courses', { title: 'Test', date: '2026-11-20', start: '09:00', end: '10:00', repeatWeeks: 3 });
    assert.equal(r.status, 401);
    r = await srv.post('/api/courses', { title: 'Test', date: '2026-11-20', start: '09:00', end: '10:00', repeatWeeks: 3 }, tokB);
    assert.deepEqual(r.body.map((c) => c.date), ['2026-11-20', '2026-11-27', '2026-12-04']);
    assert.equal(r.body[0].teacher, 'Mr Bob');
    bClass = r.body[0];
    assert.equal((await srv.api(`/api/courses/${bClass.id}`, { method: 'DELETE' }, tokA)).status, 404);
    assert.equal((await srv.api(`/api/attendance/${bClass.room}`, {}, tokA)).status, 403);
  });

  it('only real class codes can be joined; the owner is the teacher', async () => {
    let r = await join(await srv.connect(), { room: 'abc-def-ghj', name: 'Kid' });
    assert.match(r.error, /no class with this code/);
    r = await join(await srv.connect(), { room: bClass.room, name: 'Kid', token: tokA });
    assert.equal(r.role, 'student');
    const owner = await srv.connect();
    r = await join(owner, { room: bClass.room, name: 'ignored', token: tokB });
    assert.equal(r.role, 'teacher');
    assert.equal(r.name, 'Mr Bob');
    r = await join(owner, { room: bClass.room, name: 'again' });
    assert.ok(r.error, 'joining twice is refused');
    assert.equal((await srv.api(`/api/attendance/${bClass.room}`, {}, tokB)).body.length, 2);
  });

  it('"start a class now" rooms need a teacher', async () => {
    assert.equal((await srv.post('/api/rooms', {})).status, 401);
    const r = await srv.post('/api/rooms', {}, tokA);
    assert.ok((await join(await srv.connect(), { room: r.body.room, name: 'Kid2' })).ok);
  });

  it('survives bad socket messages and cleans whiteboard strokes', async () => {
    const t = await srv.connect();
    await join(t, { room: bClass.room, name: 'x', token: tokB });
    const kid = await srv.connect();
    await join(kid, { room: bClass.room, name: 'Kid3' });
    for (const ev of ['join', 'state', 'signal', 'teacher', 'chat', 'draw', 'react', 'undo', 'vote']) { kid.emit(ev, null); kid.emit(ev, 42); }
    const got = [];
    t.on('draw', (d) => got.push(d));
    kid.emit('draw', { id: 'a1', c: '#2F6FED', w: 4, pts: [[1, 2], [3, 4]] });
    kid.emit('draw', { id: 'a2', c: 'red;evil', w: 4, pts: [[1, 2], [3, 4]] });
    kid.emit('draw', { id: 'a3', c: '#000000', w: 4, pts: Array.from({ length: 5000 }, (_, i) => [i, i]) });
    kid.emit('draw', { id: 'a4', c: '#000000', w: 1e9, pts: [[1e9, -1e9], ['x', 2]] });
    kid.emit('draw', { id: 'a5', e: 1, w: 9999, pts: [[1e9, -1e9], [5, 5]], junk: 'x'.repeat(1000) });
    await wait(300);
    assert.equal((await srv.api('/healthz')).status, 200);
    assert.deepEqual(got.map((g) => g.id), ['a1', 'a5']);
    assert.equal(got[1].w, 100);
    assert.deepEqual(got[1].pts[0], [1700, -100]);
    assert.ok(!('junk' in got[1]));
  });

  it('logout ends the session; sign-in attempts are rate-limited', async () => {
    await srv.post('/api/auth/logout', {}, tokB);
    assert.equal((await srv.api('/api/auth/me', {}, tokB)).status, 401);
    let limited = false;
    for (let i = 0; i < 12; i++) if ((await srv.post('/api/auth/login', { username: 'x', password: 'y' })).status === 429) limited = true;
    assert.ok(limited);
  });
});
