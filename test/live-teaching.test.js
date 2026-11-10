// Shared class files, polls and quizzes, breakout groups.
const { describe, it, before, after } = require('node:test');
const { startServer, join, emitAck, next, wait, assert } = require('./helpers');

describe('live teaching', () => {
  let srv, tok, tokB, room, c1, c2, kid, kid2, teacher, late, poll, second;
  before(async () => {
    srv = await startServer();
    tok = await srv.signup('amel', 'Ms Amel');
    tokB = await srv.signup('bob', 'Mr Bob');
    const r = await srv.post('/api/courses', { title: 'Maths', date: '2026-11-20', start: '09:00', end: '10:00', repeatWeeks: 2 }, tok);
    [c1, c2] = r.body;
    room = c1.room;
  });
  after(() => srv?.stop());

  describe('class files', () => {
    const pdf = Buffer.from('%PDF-1.4 fake worksheet');
    let fileId;
    it('refuses other teachers, web pages, empty and huge files', async () => {
      assert.equal((await srv.upload(`/api/rooms/${room}/files`, 'sheet.pdf', pdf, tokB)).status, 403);
      assert.equal((await srv.upload(`/api/rooms/${room}/files`, 'evil.html', Buffer.from('<script>'), tok, 'text/html')).status, 400);
      assert.equal((await srv.upload(`/api/rooms/${room}/files`, 'empty.pdf', Buffer.alloc(0), tok)).status, 400);
      const big = await srv.upload(`/api/rooms/${room}/files`, 'big.pdf', Buffer.alloc(11 * 1024 * 1024), tok);
      assert.equal(big.status, 413);
      assert.ok(big.body.error);
    });
    it('shares a file with the live class and cleans its name', async () => {
      kid = await srv.connect();
      await join(kid, { room, name: 'Lina' });
      const changed = next(kid, 'files-changed');
      const r = await srv.upload(`/api/rooms/${room}/files`, '../../Fractions: sheet<1>.pdf', pdf, tok);
      assert.equal(r.status, 201);
      assert.equal(r.body.name, '.. .. Fractions sheet 1 .pdf');
      assert.equal((await changed).name, r.body.name);
      fileId = r.body.id;
    });
    it('lists and downloads safely for anyone with the class code', async () => {
      assert.equal((await srv.api(`/api/rooms/${room}/files`)).body.length, 1);
      assert.equal((await srv.api('/api/rooms/zzz-zzz-zzz/files')).status, 404);
      const r = await srv.api(`/api/files/${fileId}`);
      assert.ok(r.body.equals(pdf));
      assert.match(r.headers.get('content-disposition'), /^attachment/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
    });
    it('lets only the owner delete', async () => {
      assert.equal((await srv.api(`/api/files/${fileId}`, { method: 'DELETE' }, tokB)).status, 404);
      second = (await srv.upload(`/api/rooms/${room}/files`, 'second.png', Buffer.from([0x89, 0x50]), tok, 'image/png')).body.id;
      assert.equal((await srv.api(`/api/files/${fileId}`, { method: 'DELETE' }, tok)).status, 200);
      assert.equal((await srv.api(`/api/files/${fileId}`)).status, 404);
    });
  });

  describe('polls and quizzes', () => {
    it('sends the question to students without results', async () => {
      teacher = await srv.connect();
      await join(teacher, { room, name: 'x', token: tok });
      kid2 = await srv.connect();
      await join(kid2, { room, name: 'Sami' });
      const kp = next(kid, 'poll'), tp = next(teacher, 'poll');
      teacher.emit('teacher', { action: 'poll-start', q: 'Which is bigger?', options: ['1/2', '1/3', ' ', '1/4'], correct: 0 });
      poll = await kp;
      assert.equal(poll.options.length, 3, 'blank answers are dropped');
      assert.equal(poll.counts, null);
      assert.equal(poll.correct, null);
      assert.equal(poll.quiz, true);
      assert.equal((await tp).correct, 0);
    });
    it('takes one changeable answer per student', async () => {
      assert.equal((await emitAck(teacher, 'vote', { id: poll.id, choice: 0 })).ok, false);
      assert.equal((await emitAck(kid, 'vote', { id: poll.id, choice: 9 })).ok, false);
      const upd = next(teacher, 'poll');
      assert.equal((await emitAck(kid, 'vote', { id: poll.id, choice: 1 })).ok, true);
      assert.equal((await upd).counts[1], 1);
      let studentGotCounts = false;
      kid2.once('poll', () => { studentGotCounts = true; });
      await emitAck(kid, 'vote', { id: poll.id, choice: 0 });
      await emitAck(kid2, 'vote', { id: poll.id, choice: 0 });
      await wait(200);
      assert.equal(studentGotCounts, false);
    });
    it('shows results when the teacher says so, then ends', async () => {
      const shown = next(kid, 'poll');
      teacher.emit('teacher', { action: 'poll-show' });
      const sp = await shown;
      assert.deepEqual(sp.counts, [2, 0, 0]);
      assert.equal(sp.correct, 0);
      assert.ok(!sp.voters, 'students never see who voted what');
      assert.equal((await emitAck(kid, 'vote', { id: poll.id, choice: 2 })).ok, false);
      const ended = next(kid, 'poll');
      teacher.emit('teacher', { action: 'poll-end' });
      assert.equal(await ended, null);
      kid.emit('teacher', { action: 'poll-start', q: 'hack', options: ['a', 'b'] });
      await wait(150);
      late = await srv.connect();
      assert.equal((await join(late, { room, name: 'Late' })).poll, null);
    });
  });

  describe('breakout groups', () => {
    it('splits the class and keeps chat in each group', async () => {
      const bo = next(kid, 'breakout');
      teacher.emit('teacher', { action: 'breakout-start', count: 2, assign: { [kid.id]: 0, [kid2.id]: 1, [late.id]: 0, bogus: 1 } });
      const b = await bo;
      assert.equal(b.groups[kid.id], 0);
      assert.equal(b.groups[kid2.id], 1);
      assert.ok(!('bogus' in b.groups));
      const heard = { kid2: [], late: [], teacher: [] };
      kid2.on('chat', (m) => heard.kid2.push(m.text));
      late.on('chat', (m) => heard.late.push(m.text));
      teacher.on('chat', (m) => heard.teacher.push(m.text));
      kid.emit('chat', 'hello group 1');
      await wait(200);
      assert.ok(heard.late.includes('hello group 1'));
      assert.ok(!heard.kid2.includes('hello group 1'));
      assert.ok(heard.teacher.includes('hello group 1'), 'the teacher reads every group');
      teacher.emit('chat', 'two minutes left');
      await wait(200);
      assert.ok(heard.kid2.includes('two minutes left') && heard.late.includes('two minutes left'));
    });
    it('moves students, survives leavers, and ends', async () => {
      const mv = next(kid2, 'breakout');
      teacher.emit('teacher', { action: 'breakout-move', target: kid2.id, group: 0 });
      assert.equal((await mv).groups[kid2.id], 0);
      kid.emit('teacher', { action: 'breakout-end' }); // students cannot
      await wait(150);
      assert.equal((await join(await srv.connect(), { room, name: 'Peek' })).breakout.active, true);
      const id2 = kid2.id;
      const left = next(teacher, 'breakout', 2000, (b) => !(id2 in b.groups));
      kid2.disconnect();
      assert.notEqual(await left, 'TIMEOUT', 'leaving removes you from your group');
      // Lina may still receive the "Sami left" update after this point, so wait for the "ended" one
      const off = next(kid, 'breakout', 2000, (b) => !b.active);
      teacher.emit('teacher', { action: 'breakout-end' });
      assert.equal((await off).active, false);
    });
  });

  it('deletes files with the last week of their class', async () => {
    await srv.api(`/api/courses/${c1.id}`, { method: 'DELETE' }, tok);
    assert.equal((await srv.api(`/api/files/${second}`)).status, 200);
    await srv.api(`/api/courses/${c2.id}`, { method: 'DELETE' }, tok);
    assert.equal((await srv.api(`/api/files/${second}`)).status, 404);
  });
});
