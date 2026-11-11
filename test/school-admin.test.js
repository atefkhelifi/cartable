// School admin, password reset and change, backups, and teacher chat controls.
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, join, emitAck, next, wait, today, assert } = require('./helpers');

describe('school admin and passwords', () => {
  let srv, admin, bob, bobId;
  before(async () => { srv = await startServer(); });
  after(() => srv?.stop());

  it('makes the first teacher the school admin', async () => {
    admin = await srv.signup('amel', 'Ms Amel');
    bob = await srv.signup('bob', 'Mr Bob');
    assert.equal((await srv.api('/api/auth/me', {}, admin)).body.teacher.admin, true);
    assert.equal((await srv.api('/api/auth/me', {}, bob)).body.teacher.admin, false);
  });

  it('only admins see the teacher list and backups', async () => {
    assert.equal((await srv.api('/api/admin/teachers', {}, bob)).status, 403);
    assert.equal((await srv.api('/api/admin/backups', {}, bob)).status, 403);
    assert.equal((await srv.api('/api/admin/teachers')).status, 401);
    const r = await srv.api('/api/admin/teachers', {}, admin);
    // sorted by name: "Mr Bob" before "Ms Amel"
    assert.deepEqual(r.body.map((t) => [t.username, t.admin, t.me]), [['bob', false, false], ['amel', true, true]]);
    bobId = r.body[0].id;
  });

  it('resets a password with a one-time code, and signs out old sessions', async () => {
    const code = (await srv.post(`/api/admin/teachers/${bobId}/reset`, {}, admin)).body.code;
    assert.match(code, /^[a-z0-9]{5}-[a-z0-9]{5}$/);
    let r = await srv.post('/api/auth/reset', { username: 'bob', code: 'wrong-codes', password: 'brandnew123' });
    assert.equal(r.status, 401);
    r = await srv.post('/api/auth/reset', { username: 'bob', code: code.toUpperCase(), password: 'brandnew123' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await srv.api('/api/auth/me', {}, bob)).status, 401, 'the old session is gone');
    bob = r.body.token;
    // the code works only once
    r = await srv.post('/api/auth/reset', { username: 'bob', code, password: 'another1234' });
    assert.equal(r.status, 401);
  });

  it('changes a password only with the current one', async () => {
    let r = await srv.post('/api/auth/password', { current: 'nope-nope', password: 'evenmore123' }, bob);
    assert.equal(r.status, 403);
    r = await srv.post('/api/auth/password', { current: 'brandnew123', password: 'evenmore123' }, bob);
    assert.equal(r.status, 200);
    assert.equal((await srv.api('/api/auth/me', {}, bob)).status, 200, 'this device stays signed in');
  });

  it('admins manage roles but not their own', async () => {
    assert.equal((await srv.post(`/api/admin/teachers/${bobId}`, { admin: true }, admin, 'PATCH')).status, 200);
    assert.equal((await srv.api('/api/auth/me', {}, bob)).body.teacher.admin, true);
    const me = (await srv.api('/api/admin/teachers', {}, admin)).body.find((t) => t.me).id;
    assert.equal((await srv.post(`/api/admin/teachers/${me}`, { admin: false }, admin, 'PATCH')).status, 400);
    assert.equal((await srv.api(`/api/admin/teachers/${me}`, { method: 'DELETE' }, admin)).status, 400);
  });

  it('makes and downloads backups', async () => {
    const made = await srv.post('/api/admin/backups', {}, admin);
    assert.equal(made.status, 201);
    const list = (await srv.api('/api/admin/backups', {}, admin)).body.list;
    assert.ok(list.some((b) => b.name === made.body.name));
    const dl = await srv.api(`/api/admin/backups/${made.body.name}`, {}, admin);
    assert.equal(dl.status, 200);
    assert.equal(dl.body.subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await srv.api('/api/admin/backups/..%2Fcartable.db', {}, admin)).status, 404);
  });

  it('deleting a teacher deletes their classes', async () => {
    const r = await srv.post('/api/courses', { title: 'Maths', date: today(), start: '09:00', end: '10:00' }, bob);
    assert.equal(r.status, 201);
    assert.equal((await srv.api(`/api/admin/teachers/${bobId}`, { method: 'DELETE' }, admin)).status, 200);
    assert.equal((await srv.api('/api/auth/me', {}, bob)).status, 401);
    const s = await srv.connect();
    assert.ok((await join(s, { room: r.body[0].room, name: 'Lina' })).error);
  });

  it('the reset-code script works when no admin can sign in', () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'reset-code.js'), 'amel'], { env: { ...process.env, DATA_DIR: srv.dataDir } }).toString();
    const code = out.match(/: ([a-z0-9]{5}-[a-z0-9]{5})/)[1];
    return srv.post('/api/auth/reset', { username: 'amel', code, password: 'recovered99' }).then((r) => assert.equal(r.status, 200));
  });
});

describe('teacher chat controls', () => {
  let srv, teach, room, t, a, b;
  before(async () => {
    srv = await startServer();
    teach = await srv.signup('amel');
    room = (await srv.post('/api/rooms', {}, teach)).body.room;
    [t, a, b] = await Promise.all([srv.connect(), srv.connect(), srv.connect()]);
    assert.equal((await join(t, { room, token: teach })).role, 'teacher');
    await join(a, { room, name: 'Lina' });
    await join(b, { room, name: 'Sami' });
  });
  after(() => srv?.stop());

  it('everyone gets a message with an id, and the teacher can delete it', async () => {
    const got = next(b, 'chat');
    assert.deepEqual(await emitAck(a, 'chat', 'hello'), { ok: true });
    const m = await got;
    assert.match(m.id, /^[0-9a-f]{12}$/);
    const del = next(b, 'chat-delete');
    a.emit('teacher', { action: 'chat-delete', id: m.id }); // students cannot
    assert.equal(await next(b, 'chat-delete', 300), 'TIMEOUT');
    t.emit('teacher', { action: 'chat-delete', id: m.id });
    assert.equal(await del, m.id);
  });

  it('"to the teacher only" keeps messages away from other students', async () => {
    t.emit('teacher', { action: 'chat-mode', mode: 'teacher' });
    assert.equal((await next(a, 'room-flags', 2000, (f) => f.chat === 'teacher')).chat, 'teacher');
    const toTeacher = next(t, 'chat'), back = next(a, 'chat'), other = next(b, 'chat', 400);
    a.emit('chat', 'I need help');
    assert.equal((await toTeacher).private, true);
    assert.equal((await back).text, 'I need help');
    assert.equal(await other, 'TIMEOUT');
  });

  it('"only me" stops students but not the teacher', async () => {
    t.emit('teacher', { action: 'chat-mode', mode: 'off' });
    await next(a, 'room-flags', 2000, (f) => f.chat === 'off');
    assert.ok((await emitAck(a, 'chat', 'hi')).error);
    assert.deepEqual(await emitAck(t, 'chat', 'Listen please'), { ok: true });
    t.emit('teacher', { action: 'chat-mode', mode: 'all' });
    await next(a, 'room-flags', 2000, (f) => f.chat === 'all');
  });

  it('stops one student\'s messages', async () => {
    const told = next(b, 'chat-muted');
    const seen = next(a, 'peer-state', 2000, (p) => p.name === 'Sami');
    t.emit('teacher', { action: 'chat-mute', target: b.id });
    assert.equal(await told, true);
    assert.equal((await seen).chatMuted, true);
    assert.ok((await emitAck(b, 'chat', 'hey')).error);
    assert.deepEqual(await emitAck(a, 'chat', 'still here'), { ok: true });
    t.emit('teacher', { action: 'chat-mute', target: b.id });
    assert.equal(await next(b, 'chat-muted'), false);
    await wait(50);
    assert.deepEqual(await emitAck(b, 'chat', 'thanks'), { ok: true });
  });
});
