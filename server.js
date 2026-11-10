// Cartable — open-source online classroom (MIT License)
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
// The school code is only needed to create a teacher account.
const SCHOOL_CODE = String(process.env.TEACHER_CODE || 'teach').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTENDANCE_DAYS = Math.max(parseInt(process.env.ATTENDANCE_DAYS, 10) || 365, 1);
const SESSION_DAYS = 30;
const INSTANT_ROOM_HOURS = 12;
const DAY = 24 * 3600e3;

// ICE servers for WebRTC. STUN is enough on most home networks; school and
// mobile networks often need a TURN relay (set TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL).
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URLS) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

// ---------- database (SQLite) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const sql = new DatabaseSync(path.join(DATA_DIR, 'cartable.db'));
sql.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    series TEXT NOT NULL,
    room TEXT NOT NULL,
    teacher_id TEXT REFERENCES teachers(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    grp TEXT NOT NULL DEFAULT '',
    teacher TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'blue'
  );
  CREATE INDEX IF NOT EXISTS courses_room ON courses(room);
  CREATE INDEX IF NOT EXISTS courses_teacher ON courses(teacher_id);
  CREATE TABLE IF NOT EXISTS instant_rooms (
    room TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attendance_room ON attendance(room);
`);
// columns added after 1.1
if (!sql.prepare('PRAGMA table_info(courses)').all().some((c) => c.name === 'waiting_room')) {
  sql.exec('ALTER TABLE courses ADD COLUMN waiting_room INTEGER NOT NULL DEFAULT 0');
}

const q = {
  teacherByUser: sql.prepare('SELECT * FROM teachers WHERE username = ?'),
  addTeacher: sql.prepare('INSERT INTO teachers (id, username, name, pass, created_at) VALUES (?, ?, ?, ?, ?)'),
  teacherCount: sql.prepare('SELECT COUNT(*) AS n FROM teachers'),
  claimOrphans: sql.prepare('UPDATE courses SET teacher_id = ? WHERE teacher_id IS NULL'),
  addSession: sql.prepare('INSERT INTO sessions (token_hash, teacher_id, expires_at) VALUES (?, ?, ?)'),
  session: sql.prepare('SELECT t.id, t.username, t.name FROM sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  delSession: sql.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  addCourse: sql.prepare(`INSERT INTO courses (id, series, room, teacher_id, title, date, start_time, end_time, subject, grp, teacher, notes, color, waiting_room)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  editCourse: sql.prepare(`UPDATE courses SET title = ?, date = ?, start_time = ?, end_time = ?, subject = ?, grp = ?, notes = ?, color = ?, waiting_room = ?
    WHERE id = ? AND teacher_id = ?`),
  editSeries: sql.prepare(`UPDATE courses SET title = ?, start_time = ?, end_time = ?, subject = ?, grp = ?, notes = ?, color = ?, waiting_room = ?
    WHERE series = ? AND teacher_id = ?`),
  coursesByTeacher: sql.prepare('SELECT * FROM courses WHERE teacher_id = ? ORDER BY date, start_time'),
  coursesByRoom: sql.prepare('SELECT * FROM courses WHERE room = ? ORDER BY date, start_time'),
  course: sql.prepare('SELECT * FROM courses WHERE id = ?'),
  delCourse: sql.prepare('DELETE FROM courses WHERE id = ? AND teacher_id = ?'),
  delSeries: sql.prepare('DELETE FROM courses WHERE series = ? AND teacher_id = ?'),
  courseOwner: sql.prepare('SELECT teacher_id, MAX(waiting_room) AS waiting FROM courses WHERE room = ? GROUP BY teacher_id LIMIT 1'),
  addInstant: sql.prepare('INSERT INTO instant_rooms (room, teacher_id, expires_at) VALUES (?, ?, ?)'),
  instantRoom: sql.prepare('SELECT teacher_id, expires_at FROM instant_rooms WHERE room = ?'),
  addAttendance: sql.prepare('INSERT INTO attendance (room, name, role, at) VALUES (?, ?, ?, ?)'),
  attendance: sql.prepare('SELECT name, role, at FROM attendance WHERE room = ? ORDER BY at'),
};

function tx(fn) {
  sql.exec('BEGIN');
  try { const r = fn(); sql.exec('COMMIT'); return r; }
  catch (e) { sql.exec('ROLLBACK'); throw e; }
}

// One-time import of the old data/db.json store.
const OLD_DB = path.join(DATA_DIR, 'db.json');
if (fs.existsSync(OLD_DB)) {
  try {
    const old = JSON.parse(fs.readFileSync(OLD_DB, 'utf8'));
    tx(() => {
      for (const c of old.courses || []) {
        if (q.course.get(c.id)) continue;
        q.addCourse.run(c.id, c.series || c.id, c.room, null, c.title || '', c.date, c.start, c.end,
          c.subject || '', c.group || '', c.teacher || '', c.notes || '', c.color || 'blue', 0);
      }
      for (const [room, list] of Object.entries(old.attendance || {})) {
        for (const a of list) q.addAttendance.run(room, a.name || '', a.role || 'student', Date.parse(a.at) || Date.now());
      }
    });
    fs.renameSync(OLD_DB, OLD_DB + '.migrated');
    console.log('Imported data/db.json into SQLite (old file renamed to db.json.migrated).');
  } catch (e) {
    console.error('Could not import data/db.json:', e.message);
  }
}

// Remove expired sessions, old instant rooms and old attendance records.
function prune() {
  const now = Date.now();
  sql.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  sql.prepare('DELETE FROM instant_rooms WHERE expires_at < ?').run(now - ATTENDANCE_DAYS * DAY);
  sql.prepare('DELETE FROM attendance WHERE at < ?').run(now - ATTENDANCE_DAYS * DAY);
}
prune();
setInterval(prune, 6 * 3600e3).unref();

const toCourse = (r) => ({
  id: r.id, series: r.series, room: r.room, title: r.title, date: r.date, start: r.start_time, end: r.end_time,
  subject: r.subject, group: r.grp, teacher: r.teacher, notes: r.notes, color: r.color, waitingRoom: !!r.waiting_room,
});

// Who owns a room code? Returns { teacherId, open, waiting } or null if the code is unknown.
function roomInfo(room) {
  const c = q.courseOwner.get(room);
  if (c) return { teacherId: c.teacher_id, open: true, waiting: !!c.waiting };
  const i = q.instantRoom.get(room);
  if (i) return { teacherId: i.teacher_id, open: i.expires_at > Date.now(), waiting: false };
  return null;
}

// ---------- helpers ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const ROOM_RE = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/;
const roomCode = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 9; i++) s += a[crypto.randomInt(a.length)] + (i === 2 || i === 5 ? '-' : '');
  return s;
};
const freeRoomCode = () => { let r; do r = roomCode(); while (roomInfo(r)); return r; };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function teacherFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return q.session.get(sha256(token), Date.now()) || null;
}

// Tiny fixed-window rate limiter: allow `max` hits per `windowMs` for each key.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    return ++h.n <= max;
  };
}
const authLimit = limiter(10, 15 * 60e3);   // sign-in / sign-up attempts per IP
const roomLimit = limiter(60, 15 * 60e3);   // unknown room codes tried per IP

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/config', (req, res) => res.json({ iceServers: ICE_SERVERS }));
app.use(express.static(path.join(__dirname, 'public')));

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
app.use('/api', (req, res, next) => { req.teacher = teacherFromToken(bearer(req)); next(); });
const needTeacher = (req, res, next) => (req.teacher ? next() : res.status(401).json({ error: 'Please sign in as a teacher.' }));

function startSession(res, t) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha256(token), t.id, Date.now() + SESSION_DAYS * DAY);
  res.json({ token, teacher: { id: t.id, username: t.username, name: t.name } });
}

app.post('/api/auth/signup', (req, res) => {
  if (!authLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const b = req.body || {};
  if (PROD && SCHOOL_CODE === 'teach') return res.status(403).json({ error: 'Teacher accounts are turned off until the school sets its own code.' });
  if (typeof b.schoolCode !== 'string' || b.schoolCode.trim() !== SCHOOL_CODE) return res.status(403).json({ error: 'That school code is not right. Ask your school for it.' });
  const name = String(b.name || '').trim().slice(0, 30);
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!name) return res.status(400).json({ error: 'Add your name.' });
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Pick a username of 3 to 30 letters or numbers.' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (q.teacherByUser.get(username)) return res.status(409).json({ error: 'That username is taken. Pick another one.' });
  const t = { id: newId(), username, name };
  tx(() => {
    const first = q.teacherCount.get().n === 0;
    q.addTeacher.run(t.id, username, name, hashPassword(password), Date.now());
    if (first) q.claimOrphans.run(t.id); // classes from before accounts existed go to the first teacher
  });
  res.status(201);
  startSession(res, t);
});

app.post('/api/auth/login', (req, res) => {
  if (!authLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const b = req.body || {};
  const t = q.teacherByUser.get(String(b.username || '').trim().toLowerCase());
  const ok = checkPassword(String(b.password || ''), t ? t.pass : DUMMY_HASH);
  if (!t || !ok) return res.status(401).json({ error: 'That username or password is not right.' });
  startSession(res, t);
});

app.post('/api/auth/logout', (req, res) => {
  const token = bearer(req);
  if (token) q.delSession.run(sha256(token));
  res.json({ ok: true });
});

app.get('/api/auth/me', needTeacher, (req, res) => res.json({ teacher: req.teacher }));

// Teachers get their own classes. Students get only the classes whose codes they know.
app.get('/api/courses', (req, res) => {
  if (req.teacher) return res.json(q.coursesByTeacher.all(req.teacher.id).map(toCourse));
  const rooms = [...new Set(String(req.query.rooms || '').split(',').map((s) => s.trim()).filter((s) => ROOM_RE.test(s)))].slice(0, 50);
  res.json(rooms.flatMap((r) => q.coursesByRoom.all(r)).map(toCourse));
});

// Check the fields of a class form. Returns { error } or the cleaned fields.
function courseFields(b) {
  b = b || {};
  const title = String(b.title || '').trim().slice(0, 80);
  const validDate = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && !Number.isNaN(Date.parse(b.date + 'T00:00:00Z'));
  const time = (x) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  if (!title || !validDate || !time(b.start) || !time(b.end)) return { error: 'Add a title, a date, a start time and an end time.' };
  if (b.end <= b.start) return { error: 'The class must end after it starts.' };
  return {
    title, date: b.date, start: b.start, end: b.end,
    subject: String(b.subject || '').slice(0, 40), group: String(b.group || '').slice(0, 40),
    notes: String(b.notes || '').slice(0, 500),
    color: ['blue', 'green', 'yellow', 'red', 'purple', 'orange'].includes(b.color) ? b.color : 'blue',
    waitingRoom: b.waitingRoom === true || b.waitingRoom === '1' || b.waitingRoom === 'on',
  };
}

app.post('/api/courses', needTeacher, (req, res) => {
  const f = courseFields(req.body);
  if (f.error) return res.status(400).json(f);
  const repeat = Math.min(Math.max(parseInt(req.body.repeatWeeks, 10) || 1, 1), 40);
  const series = newId();
  const room = freeRoomCode();
  const created = [];
  tx(() => {
    for (let w = 0; w < repeat; w++) {
      const d = new Date(f.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7 * w);
      const c = { ...f, id: newId(), series, room, date: d.toISOString().slice(0, 10), teacher: req.teacher.name };
      q.addCourse.run(c.id, series, room, req.teacher.id, c.title, c.date, c.start, c.end, c.subject, c.group, c.teacher, c.notes, c.color, c.waitingRoom ? 1 : 0);
      created.push(c);
    }
  });
  res.status(201).json(created);
});

// Edit one class, or (?series=1) every week of it. The date only changes for a single class.
app.patch('/api/courses/:id', needTeacher, (req, res) => {
  const c = q.course.get(req.params.id);
  if (!c || c.teacher_id !== req.teacher.id) return res.status(404).json({ error: 'Class not found.' });
  const all = req.query.series === '1';
  const f = courseFields({ date: c.date, ...req.body, ...(all ? { date: c.date } : {}) });
  if (f.error) return res.status(400).json(f);
  const w = f.waitingRoom ? 1 : 0;
  if (all) q.editSeries.run(f.title, f.start, f.end, f.subject, f.group, f.notes, f.color, w, c.series, req.teacher.id);
  else q.editCourse.run(f.title, f.date, f.start, f.end, f.subject, f.group, f.notes, f.color, w, c.id, req.teacher.id);
  res.json({ ok: true });
});

app.delete('/api/courses/:id', needTeacher, (req, res) => {
  const c = q.course.get(req.params.id);
  if (!c || c.teacher_id !== req.teacher.id) return res.status(404).json({ error: 'Class not found.' });
  if (req.query.series === '1') q.delSeries.run(c.series, req.teacher.id);
  else q.delCourse.run(c.id, req.teacher.id);
  res.json({ ok: true });
});

app.get('/api/attendance/:room', needTeacher, (req, res) => {
  const info = roomInfo(req.params.room);
  if (!info || info.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Only the class teacher can see attendance.' });
  res.json(q.attendance.all(req.params.room).map((a) => ({ name: a.name, role: a.role, at: new Date(a.at).toISOString() })));
});

// "Start a class now": a room that lives for a few hours.
app.post('/api/rooms', needTeacher, (req, res) => {
  const room = freeRoomCode();
  q.addInstant.run(room, req.teacher.id, Date.now() + INSTANT_ROOM_HOURS * 3600e3);
  res.status(201).json({ room });
});

// Whiteboard background (a picture or a PDF page, turned into a JPEG by the teacher's browser).
// It lives in memory with the live class and is gone when everyone leaves.
const liveRoomOf = (req, res) => {
  const room = req.params.room;
  const r = ROOM_RE.test(room) && rooms.get(room);
  if (!r) { res.status(404).json({ error: 'This class is not live right now.' }); return null; }
  return r;
};
const ownsRoom = (req, res) => {
  const info = roomInfo(req.params.room);
  if (!info || info.teacherId !== req.teacher.id) { res.status(403).json({ error: 'Only the class teacher can change the whiteboard background.' }); return false; }
  return true;
};
app.put('/api/rooms/:room/background', needTeacher, express.raw({ type: 'image/jpeg', limit: '3mb' }), (req, res) => {
  if (!ownsRoom(req, res)) return;
  const r = liveRoomOf(req, res); if (!r) return;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return res.status(400).json({ error: 'That picture could not be used. Try another one.' });
  }
  r.bg = { buf, v: Date.now() };
  io.to(req.params.room).emit('board-bg', { v: r.bg.v });
  res.json({ v: r.bg.v });
});
app.delete('/api/rooms/:room/background', needTeacher, (req, res) => {
  if (!ownsRoom(req, res)) return;
  const r = liveRoomOf(req, res); if (!r) return;
  r.bg = null;
  io.to(req.params.room).emit('board-bg', { v: 0 });
  res.json({ ok: true });
});
app.get('/api/rooms/:room/background', (req, res) => {
  const r = liveRoomOf(req, res); if (!r) return;
  if (!r.bg) return res.status(404).json({ error: 'No background.' });
  res.set({ 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }).send(r.bg.buf);
});

// ---------- live rooms (WebRTC signaling) ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e5 });

// room -> { peers: Map<socketId, {name, role, hand, mic, cam}>, lobby: Map<socketId, {name, admit}>,
//           locked, boardLocked, waiting, strokes: [{ s, by }], points, bg, recording }
const rooms = new Map();
function getRoom(id, info) {
  if (!rooms.has(id)) {
    rooms.set(id, { peers: new Map(), lobby: new Map(), locked: false, boardLocked: false, waiting: !!info?.waiting, strokes: [], points: 0, bg: null, recording: null });
  }
  return rooms.get(id);
}
const peerList = (r) => [...r.peers].map(([id, p]) => ({ id, ...p }));
const lobbyList = (r) => [...r.lobby].map(([id, p]) => ({ id, name: p.name }));
const flags = (r) => ({ locked: r.locked, boardLocked: r.boardLocked, waiting: r.waiting });
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function sendLobby(r) {
  const list = lobbyList(r);
  for (const [id, p] of r.peers) if (p.role === 'teacher') io.to(id).emit('lobby', list);
}
function dropRoomIfEmpty(id) {
  const r = rooms.get(id);
  if (r && r.peers.size === 0 && r.lobby.size === 0) rooms.delete(id);
}

// Whiteboard items are checked before they are stored or relayed.
// pen: {id, c, w, pts}   eraser: {id, e: 1, w, pts}   shape: {id, k, c, w, pts: [a, b]}   text: {id, k: 'text', c, s, pts: [a], txt}
const MAX_STROKE_POINTS = 1000, MAX_BOARD_POINTS = 200000;
const SHAPES = ['line', 'arrow', 'rect', 'ellipse'];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function cleanStroke(s) {
  if (!isObj(s) || !Array.isArray(s.pts) || s.pts.length < 1 || s.pts.length > MAX_STROKE_POINTS) return null;
  if (typeof s.id !== 'string' || !/^[a-z0-9]{1,16}$/i.test(s.id)) return null;
  const pts = [];
  for (const p of s.pts) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([clamp(Math.round(x * 10) / 10, -100, 1700), clamp(Math.round(y * 10) / 10, -100, 1100)]);
  }
  const w = clamp(Number(s.w) || 4, 1, 100);
  if (s.e) return { id: s.id, e: 1, w, pts };
  if (typeof s.c !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.c)) return null;
  if (s.k === undefined) return { id: s.id, c: s.c, w, pts };
  if (SHAPES.includes(s.k)) return pts.length === 2 ? { id: s.id, k: s.k, c: s.c, w, pts } : null;
  if (s.k === 'text') {
    const txt = typeof s.txt === 'string' ? s.txt.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    if (!txt || pts.length !== 1) return null;
    return { id: s.id, k: 'text', c: s.c, s: clamp(Number(s.s) || 24, 10, 120), pts, txt };
  }
  return null;
}

const clientIp = (socket) => (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;

io.on('connection', (socket) => {
  let roomId = null;
  let me = null;
  // per-socket flood limits
  const drawLimit = limiter(80, 1000);
  const chatLimit = limiter(5, 5000);
  const reactLimit = limiter(10, 5000);
  const signalLimit = limiter(400, 10000);
  const on = (event, fn) => socket.on(event, (...args) => {
    try { fn(...args); } catch (e) { console.error(`socket "${event}" failed:`, e.message); }
  });

  on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (roomId) return reply({ error: 'You are already in a class.' });
    if (!isObj(payload)) return reply({ error: 'This class link is not valid.' });
    const { room, name, token } = payload;
    if (typeof room !== 'string' || !ROOM_RE.test(room)) return reply({ error: 'This class link is not valid.' });
    const info = roomInfo(room);
    if (!info || !info.open) {
      if (!roomLimit(clientIp(socket))) return reply({ error: 'Too many tries. Wait a few minutes and try again.' });
      return reply({ error: 'There is no class with this code. Check the code with your teacher.' });
    }
    const t = teacherFromToken(token);
    const teacher = !!t && t.id === info.teacherId;
    const r = getRoom(room, info);
    if (r.locked && !teacher) { dropRoomIfEmpty(room); return reply({ error: 'The teacher has locked this class. Ask them to unlock it.' }); }
    const myName = (teacher ? t.name : String(name || '').trim()).slice(0, 30) || 'Guest';

    // Put this person in the class. Returns the welcome message, or an error if the class is full.
    const enter = () => {
      if (r.peers.size >= 16) return { error: 'This class is full (16 people max).' };
      me = { name: myName, role: teacher ? 'teacher' : 'student', hand: false, mic: true, cam: true };
      socket.join(room);
      const others = peerList(r);
      r.peers.set(socket.id, me);
      q.addAttendance.run(room, me.name, me.role, Date.now());
      socket.to(room).emit('peer-joined', { id: socket.id, ...me });
      return {
        ok: true, id: socket.id, role: me.role, name: me.name, peers: others, strokes: r.strokes.map((x) => x.s),
        ...flags(r), recording: !!r.recording, bg: r.bg ? r.bg.v : 0, lobby: teacher ? lobbyList(r) : [],
      };
    };

    roomId = room;
    if (r.waiting && !teacher) {
      if (r.lobby.size >= 30) { roomId = null; dropRoomIfEmpty(room); return reply({ error: 'The waiting room is full. Try again in a moment.' }); }
      r.lobby.set(socket.id, {
        name: myName,
        admit: () => {
          r.lobby.delete(socket.id);
          const res = enter();
          socket.emit('admitted', res);
          if (res.error) socket.disconnect(true);
        },
      });
      sendLobby(r);
      return reply({ inLobby: true });
    }
    const res = enter();
    if (res.error) { roomId = null; dropRoomIfEmpty(room); }
    reply(res);
  });

  // relay WebRTC signals to one peer
  on('signal', (msg) => {
    if (!roomId || !me || !isObj(msg) || typeof msg.to !== 'string' || !isObj(msg.data) || !signalLimit(1)) return;
    if (!getRoom(roomId).peers.has(msg.to)) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  on('chat', (text) => {
    if (!roomId || !me || typeof text !== 'string' || !chatLimit(1)) return;
    const t = text.trim().slice(0, 500);
    if (t) io.to(roomId).emit('chat', { from: socket.id, name: me.name, role: me.role, text: t, at: Date.now() });
  });

  on('state', (patch) => {
    if (!roomId || !me || !isObj(patch)) return;
    for (const k of ['hand', 'mic', 'cam', 'sharing']) if (k in patch) me[k] = !!patch[k];
    io.to(roomId).emit('peer-state', { id: socket.id, ...me });
  });

  on('react', (emoji) => {
    if (!roomId || !me || !reactLimit(1)) return;
    if (['👍', '👏', '❤️', '😂', '🎉', '❓'].includes(emoji)) io.to(roomId).emit('react', { id: socket.id, name: me.name, emoji });
  });

  on('draw', (raw) => {
    if (!roomId || !me || !drawLimit(1)) return;
    const r = getRoom(roomId);
    if (r.boardLocked && me.role !== 'teacher') return;
    const stroke = cleanStroke(raw);
    if (!stroke) return;
    r.strokes.push({ s: stroke, by: socket.id });
    r.points += stroke.pts.length;
    while (r.strokes.length > 5000 || r.points > MAX_BOARD_POINTS) r.points -= r.strokes.shift().s.pts.length;
    socket.to(roomId).emit('draw', stroke);
  });

  // undo: remove every piece of one of my own strokes
  on('undo', (id) => {
    if (!roomId || !me || typeof id !== 'string' || !drawLimit(1)) return;
    const r = getRoom(roomId);
    if (r.boardLocked && me.role !== 'teacher') return;
    const keep = r.strokes.filter((x) => !(x.s.id === id && x.by === socket.id));
    if (keep.length === r.strokes.length) return;
    r.strokes = keep;
    r.points = keep.reduce((n, x) => n + x.s.pts.length, 0);
    socket.to(roomId).emit('board-remove', id);
  });

  // teacher-only controls
  on('teacher', (msg) => {
    if (!roomId || !me || me.role !== 'teacher' || !isObj(msg)) return;
    const { action, target } = msg;
    const r = getRoom(roomId);
    const has = typeof target === 'string' && r.peers.has(target);
    const waiting = typeof target === 'string' && r.lobby.get(target);
    switch (action) {
      case 'clear-board': r.strokes = []; r.points = 0; io.to(roomId).emit('clear-board'); break;
      case 'lock': r.locked = !r.locked; io.to(roomId).emit('room-flags', flags(r)); break;
      case 'lock-board': r.boardLocked = !r.boardLocked; io.to(roomId).emit('room-flags', flags(r)); break;
      case 'waiting':
        r.waiting = !r.waiting;
        if (!r.waiting) [...r.lobby.values()].forEach((p) => p.admit());
        io.to(roomId).emit('room-flags', flags(r));
        sendLobby(r);
        break;
      case 'admit': if (waiting) { waiting.admit(); sendLobby(r); } break;
      case 'admit-all': [...r.lobby.values()].forEach((p) => p.admit()); sendLobby(r); break;
      case 'deny':
        if (waiting) {
          r.lobby.delete(target);
          io.to(target).emit('denied');
          io.sockets.sockets.get(target)?.disconnect(true);
          sendLobby(r);
        }
        break;
      case 'mute-all': socket.to(roomId).emit('force-mute'); break;
      case 'mute': if (has) io.to(target).emit('force-mute'); break;
      case 'lower-hand': if (has) io.to(target).emit('force-lower-hand'); break;
      case 'remove': if (has) { io.to(target).emit('removed'); io.sockets.sockets.get(target)?.disconnect(true); } break;
      case 'end': io.to(roomId).emit('ended'); [...r.lobby.keys()].forEach((id) => io.to(id).emit('ended')); break;
      case 'record-start': r.recording = socket.id; io.to(roomId).emit('recording', { on: true, name: me.name }); break;
      case 'record-stop': if (r.recording) { r.recording = null; io.to(roomId).emit('recording', { on: false }); } break;
    }
  });

  on('disconnect', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.lobby.delete(socket.id)) sendLobby(r);
    if (r.peers.delete(socket.id)) {
      if (r.recording === socket.id) { r.recording = null; socket.to(roomId).emit('recording', { on: false }); }
      socket.to(roomId).emit('peer-left', { id: socket.id });
    }
    dropRoomIfEmpty(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Cartable is running on http://localhost:${PORT}`);
  if (SCHOOL_CODE === 'teach') {
    if (PROD) console.warn('WARNING: TEACHER_CODE is not set, so new teacher accounts are turned off. Set a secret TEACHER_CODE.');
    else console.log('School code is "teach" (needed to create teacher accounts). Set TEACHER_CODE to change it.');
  }
});
