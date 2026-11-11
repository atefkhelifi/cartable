// Stars ("bons points"), live captions, the data-saver flag, data export and deleting an account.
const { describe, it, before, after } = require('node:test');
const { startServer, join, next, wait, assert } = require('./helpers');

describe('stars, captions and your data', () => {
  let srv, teach, other, roster, lina, linaTok, parentTok, room, t, a, b;
  before(async () => {
    srv = await startServer({ env: { PRIVACY_CONTACT: 'privacy@school.example' } });
    teach = await srv.signup('amel', 'Ms Amel');
    other = await srv.signup('bob', 'Mr Bob');
    roster = (await srv.post('/api/rosters', { name: 'Year 3' }, teach)).body.id;
    [lina] = (await srv.post(`/api/rosters/${roster}/students`, { names: ['Lina'] }, teach)).body;
    linaTok = (await srv.post('/api/auth/code', { code: lina.code })).body.token;
    parentTok = (await srv.post('/api/auth/code', { code: lina.parentCode })).body.token;
    room = (await srv.post('/api/rooms', {}, teach)).body.room;
    [t, a, b] = await Promise.all([srv.connect(), srv.connect(), srv.connect()]);
    await join(t, { room, token: teach });
    await join(a, { room, token: linaTok });
    await join(b, { room, name: 'Guest Sami' });
  });
  after(() => srv?.stop());

  it('gives stars from the class list, only to your own students', async () => {
    let r = await srv.post(`/api/students/${lina.id}/stars`, { reason: 'help' }, teach);
    assert.equal(r.status, 201);
    assert.equal(r.body.stars, 1);
    assert.equal((await srv.post(`/api/students/${lina.id}/stars`, { reason: 'help' }, other)).status, 404);
    assert.equal((await srv.post(`/api/students/${lina.id}/stars`, { reason: 'nope' }, teach)).status, 400);
    assert.equal((await srv.api(`/api/rosters/${roster}/students`, {}, teach)).body[0].stars, 1);
    // undo
    const id = (await srv.post(`/api/students/${lina.id}/stars`, { reason: 'idea' }, teach)).body.id;
    assert.equal((await srv.api(`/api/stars/${id}`, { method: 'DELETE' }, other)).status, 404);
    assert.equal((await srv.api(`/api/stars/${id}`, { method: 'DELETE' }, teach)).status, 200);
  });

  it('gives stars in a live class: saved for students with a code, shown to everyone', async () => {
    const seen = next(b, 'star');
    t.emit('teacher', { action: 'star', target: a.id, reason: 'answer' });
    const s = await seen;
    assert.deepEqual([s.name, s.reason, s.saved], ['Lina', 'answer', true]);
    const guest = next(a, 'star');
    t.emit('teacher', { action: 'star', target: b.id, reason: 'effort' });
    assert.equal((await guest).saved, false);
    await wait(100); // let that broadcast reach everyone first
    a.emit('teacher', { action: 'star', target: b.id, reason: 'effort' }); // students cannot
    assert.equal(await next(b, 'star', 300), 'TIMEOUT');
    // Lina and her parent see her stars
    const mine = (await srv.api('/api/my/stars', {}, parentTok)).body;
    assert.equal(mine.total, 2);
    assert.deepEqual(mine.recent.map((x) => x.reason), ['answer', 'help']);
    assert.equal(mine.recent[0].teacher, 'Ms Amel');
  });

  it('relays the teacher\'s captions only while captions are on', async () => {
    t.emit('caption', { text: 'before', final: true });
    assert.equal(await next(a, 'caption', 300), 'TIMEOUT');
    t.emit('teacher', { action: 'captions', on: true });
    assert.equal((await next(a, 'room-flags', 2000, (f) => f.captions)).captions, true);
    const got = next(a, 'caption');
    t.emit('caption', { text: 'Open your books', final: false });
    assert.deepEqual(await got, { from: t.id, name: 'Ms Amel', text: 'Open your books', final: false });
    a.emit('caption', { text: 'student text' }); // only the teacher
    assert.equal(await next(b, 'caption', 300, (c) => c.text === 'student text'), 'TIMEOUT');
  });

  it('shares the data-saver flag with the others', async () => {
    const st = next(t, 'peer-state', 2000, (p) => p.id === b.id);
    b.emit('state', { saver: true });
    assert.equal((await st).saver, true);
  });

  it('exports the data of a student (also for their parent) and of a teacher', async () => {
    const p = await srv.api('/api/my/export', {}, parentTok);
    assert.equal(p.status, 200);
    assert.match(p.headers.get('content-disposition'), /attachment/);
    const pd = p.body;
    assert.equal(pd.as, 'parent');
    assert.equal(pd.student.name, 'Lina');
    assert.equal(pd.stars.length, 2);
    assert.equal(pd.attendance.length, 1);
    const td = (await srv.api('/api/my/export', {}, teach)).body;
    assert.equal(td.account.username, 'amel');
    assert.equal(td.classLists[0].students[0].name, 'Lina');
    assert.ok(!JSON.stringify(td).includes(lina.code), 'no sign-in codes in the export');
    assert.equal((await srv.api('/api/my/export')).status, 401);
    assert.equal((await srv.api('/api/config')).body.privacyContact, 'privacy@school.example');
  });

  it('a teacher deletes their own account, but the school keeps an admin', async () => {
    assert.equal((await srv.post('/api/auth/account', { password: 'wrong-wrong' }, other, 'DELETE')).status, 403);
    // Ms Amel is the only admin while Mr Bob exists
    assert.equal((await srv.post('/api/auth/account', { password: 'longenough1' }, teach, 'DELETE')).status, 400);
    assert.equal((await srv.post('/api/auth/account', { password: 'longenough1' }, other, 'DELETE')).status, 200);
    assert.equal((await srv.api('/api/auth/me', {}, other)).status, 401);
    const ended = next(a, 'ended');
    assert.equal((await srv.post('/api/auth/account', { password: 'longenough1' }, teach, 'DELETE')).status, 200);
    assert.notEqual(await ended, 'TIMEOUT');
    await wait(50);
    assert.equal((await srv.api('/api/auth/me', {}, linaTok)).status, 401, 'her students are gone too');
  });
});
