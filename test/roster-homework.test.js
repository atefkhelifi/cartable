// Class lists with student and parent codes, homework, and the parent view.
const { describe, it, before, after } = require('node:test');
const { startServer, join, wait, assert } = require('./helpers');

describe('class lists, homework and parents', () => {
  let srv, tok, tokB, roster, lina, sami, yas, tLina, tParent, tSami, course, hw, tFile, lFile, linaSub;
  before(async () => {
    srv = await startServer();
    tok = await srv.signup('amel', 'Ms Amel');
    tokB = await srv.signup('bob', 'Mr Bob');
  });
  after(() => srv?.stop());

  it('makes a class list and codes that are shown only once', async () => {
    let r = await srv.post('/api/rosters', { name: '  Year 3 Blue ' }, tok);
    roster = r.body.id;
    assert.equal(r.body.name, 'Year 3 Blue');
    r = await srv.post(`/api/rosters/${roster}/students`, { names: ['Lina', ' Sami ', '', 'Yasmine'] }, tok);
    [lina, sami, yas] = r.body;
    assert.equal(r.body.length, 3);
    assert.match(lina.code, /^[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.match(lina.parentCode, /^p-[a-z2-9]{5}-[a-z2-9]{5}$/);
    r = await srv.api(`/api/rosters/${roster}/students`, {}, tok);
    assert.ok(!JSON.stringify(r.body).includes(lina.code), 'codes are never listed again');
    assert.equal((await srv.api(`/api/rosters/${roster}/students`, {}, tokB)).status, 404);
    assert.equal((await srv.post(`/api/rosters/${roster}/students`, { names: ['Hack'] }, tokB)).status, 404);
  });

  it('signs students and parents in with their codes', async () => {
    let r = await srv.post('/api/auth/code', { code: lina.code.toUpperCase().replace('-', ' ') });
    assert.equal(r.body.role, 'student');
    assert.equal(r.body.name, 'Lina');
    tLina = r.body.token;
    r = await srv.post('/api/auth/code', { code: lina.parentCode });
    assert.equal(r.body.role, 'parent');
    tParent = r.body.token;
    tSami = (await srv.post('/api/auth/code', { code: sami.code })).body.token;
    assert.equal((await srv.post('/api/auth/code', { code: 'aaaa-bbbb' })).status, 401);
    assert.equal((await srv.api('/api/auth/me', {}, tLina)).body.role, 'student');
    assert.equal((await srv.api('/api/rosters', {}, tLina)).status, 401);
  });

  it('shows class-list classes on the right timetables', async () => {
    course = (await srv.post('/api/courses', { title: 'Maths', date: '2026-11-20', start: '09:00', end: '10:00', rosterId: roster }, tok)).body[0];
    assert.equal(course.rosterId, roster);
    const sneaky = (await srv.post('/api/courses', { title: 'Sneaky', date: '2026-11-20', start: '09:00', end: '10:00', rosterId: roster }, tokB)).body[0];
    assert.equal(sneaky.rosterId, null);
    const other = (await srv.post('/api/courses', { title: 'Art', date: '2026-11-21', start: '09:00', end: '10:00' }, tok)).body[0];
    assert.deepEqual((await srv.api('/api/courses', {}, tLina)).body.map((c) => c.title), ['Maths']);
    assert.deepEqual((await srv.api(`/api/courses?rooms=${other.room}`, {}, tLina)).body.map((c) => c.title).sort(), ['Art', 'Maths']);
    assert.deepEqual((await srv.api(`/api/courses?rooms=${other.room}`, {}, tParent)).body.map((c) => c.title), ['Maths']);
  });

  it('uses class-list names in live classes and keeps parents out', async () => {
    let r = await join(await srv.connect(), { room: course.room, name: 'Fake Name', token: tLina });
    assert.equal(r.name, 'Lina');
    r = await join(await srv.connect(), { room: course.room, name: 'Guest kid' });
    assert.equal(r.name, 'Guest kid');
    r = await join(await srv.connect(), { room: course.room, name: 'x', token: tParent });
    assert.ok(r.error);
    await wait(100);
    const att = (await srv.api(`/api/attendance/${course.room}`, {}, tok)).body;
    assert.equal(att.find((a) => a.name === 'Lina').verified, true);
    assert.equal(att.find((a) => a.name === 'Guest kid').verified, false);
    assert.equal((await srv.api('/api/my/attendance', {}, tParent)).body[0].title, 'Maths');
  });

  it('gives homework with a file', async () => {
    let r = await srv.post('/api/homework', { rosterId: roster, title: 'Fractions sheet', instructions: 'Do page 12', due: '2026-11-25' }, tok);
    hw = r.body.id;
    assert.equal(r.status, 201);
    assert.equal((await srv.post('/api/homework', { rosterId: roster, title: 'x', due: '2026-11-25' }, tokB)).status, 400);
    r = await srv.upload(`/api/homework/${hw}/files`, 'page12.pdf', Buffer.from('%PDF teacher sheet'), tok);
    tFile = r.body.id;
    assert.equal((await srv.api('/api/homework', {}, tLina)).body[0].submittedAt, null);
    assert.equal((await srv.api(`/api/hwfiles/${tFile}`, {}, tLina)).body.toString(), '%PDF teacher sheet');
    assert.equal((await srv.api(`/api/hwfiles/${tFile}`)).status, 401);
  });

  it('lets students hand in; work stays private', async () => {
    assert.ok((await srv.post(`/api/homework/${hw}/submission`, { text: 'My answers', handIn: true }, tLina, 'PUT')).body.submittedAt);
    lFile = (await srv.upload(`/api/homework/${hw}/files`, 'lina-work.pdf', Buffer.from('%PDF lina'), tLina)).body.id;
    assert.equal((await srv.api(`/api/hwfiles/${lFile}`, {}, tSami)).status, 404, 'classmates cannot see it');
    assert.equal((await srv.api(`/api/hwfiles/${lFile}`, {}, tParent)).status, 200, "Lina's parent can");
    const tSamiParent = (await srv.post('/api/auth/code', { code: sami.parentCode })).body.token;
    assert.equal((await srv.api(`/api/hwfiles/${lFile}`, {}, tSamiParent)).status, 404);
    assert.equal((await srv.upload(`/api/homework/${hw}/files`, 'x.pdf', Buffer.from('%PDF'), tParent)).status, 404);
    assert.equal((await srv.post(`/api/homework/${hw}/submission`, { text: 'x' }, tParent, 'PUT')).status, 404);
  });

  it('lets the teacher review and mark', async () => {
    let r = await srv.api(`/api/homework/${hw}`, {}, tok);
    const row = r.body.students.find((x) => x.name === 'Lina');
    linaSub = row.submissionId;
    assert.ok(row.submittedAt);
    assert.equal(r.body.students.find((x) => x.name === 'Sami').submittedAt, null);
    r = await srv.api(`/api/submissions/${linaSub}`, {}, tok);
    assert.equal(r.body.text, 'My answers');
    assert.equal(r.body.files.length, 1);
    assert.equal((await srv.api(`/api/submissions/${linaSub}`, {}, tokB)).status, 404);
    assert.equal((await srv.api(`/api/homework/${hw}`, {}, tParent)).body.submission.mark, '', 'no mark before marking');
    await srv.post(`/api/submissions/${linaSub}`, { mark: '18/20', feedback: 'Great work!' }, tok, 'PATCH');
    assert.equal((await srv.post(`/api/homework/${hw}/submission`, { text: 'changed', handIn: true }, tLina, 'PUT')).status, 409);
    r = await srv.api(`/api/homework/${hw}`, {}, tParent);
    assert.equal(r.body.submission.mark, '18/20');
    assert.equal(r.body.submission.feedback, 'Great work!');
    const sum = (await srv.api('/api/homework', {}, tok)).body[0];
    assert.deepEqual([sum.total, sum.handed, sum.marked], [3, 1, 1]);
  });

  it('replaces lost codes and signs out the old ones', async () => {
    const r = await srv.post(`/api/students/${lina.id}/codes`, { which: 'student' }, tok);
    assert.ok(r.body.code && r.body.code !== lina.code && !r.body.parentCode);
    assert.equal((await srv.api('/api/auth/me', {}, tLina)).status, 401);
    assert.equal((await srv.post('/api/auth/code', { code: lina.code })).status, 401);
    assert.equal((await srv.api('/api/auth/me', {}, tParent)).status, 200, 'the parent code still works');
  });

  it('deletes students and class lists with their homework', async () => {
    await srv.api(`/api/students/${yas.id}`, { method: 'DELETE' }, tok);
    assert.equal((await srv.api(`/api/rosters/${roster}/students`, {}, tok)).body.length, 2);
    await srv.api(`/api/rosters/${roster}`, { method: 'DELETE' }, tok);
    assert.equal((await srv.api(`/api/hwfiles/${tFile}`, {}, tok)).status, 404);
    assert.deepEqual((await srv.api('/api/homework', {}, tok)).body, []);
    assert.equal((await srv.api('/api/courses', {}, tok)).body.find((c) => c.title === 'Maths').rosterId, null, 'classes stay');
    assert.equal((await srv.api('/api/auth/me', {}, tParent)).status, 401);
  });

  it('slows down code guessing', async () => {
    let blocked = false;
    for (let i = 0; i < 22; i++) {
      if ((await srv.post('/api/auth/code', { code: `zzzz-zzz${'abcdefghjkmnpqrstuvwx'[i]}` })).status === 429) blocked = true;
    }
    assert.ok(blocked);
  });
});
