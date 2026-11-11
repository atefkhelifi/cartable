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

// ---------- optional LiveKit media server (for bigger classes) ----------
// Without it, browsers send video to each other directly (a mesh, fine up to ~16 people).
// With LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET set, video goes through LiveKit.
const LK = process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET ? {
  url: process.env.LIVEKIT_URL.trim().replace(/\/+$/, ''),
  key: process.env.LIVEKIT_API_KEY.trim(),
  secret: process.env.LIVEKIT_API_SECRET.trim(),
} : null;
const MAX_PEOPLE = LK ? Math.min(Math.max(parseInt(process.env.MAX_CLASS_SIZE, 10) || 50, 2), 200) : 16;

// LiveKit access tokens are JWTs signed with the API secret (HS256).
function lkJwt(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: LK.key, nbf: now - 10, exp: now + ttlSeconds, ...claims })}`;
  return `${data}.${crypto.createHmac('sha256', LK.secret).update(data).digest('base64url')}`;
}
// One LiveKit room per class, and one per breakout group, so groups really cannot hear each other.
const lkRoomName = (roomId, group) => (group === null ? roomId : `${roomId}.g${group + 1}`);
const lkJoinToken = (lkRoom, identity, name) => lkJwt({
  sub: identity, name,
  video: { room: lkRoom, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
}, 6 * 3600);
// Server-side calls (remove someone, close a room). Best effort: the class goes on if LiveKit is unreachable.
async function lkApi(method, body, grant) {
  try {
    const res = await fetch(`${LK.url.replace(/^ws/, 'http')}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lkJwt({ video: grant }, 60)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}
const lkKick = (lkRoom, identity) => LK && lkApi('RemoveParticipant', { room: lkRoom, identity }, { roomAdmin: true, room: lkRoom });
const lkClose = (lkRoom) => LK && lkApi('DeleteRoom', { room: lkRoom }, { roomCreate: true });

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
  CREATE TABLE IF NOT EXISTS class_files (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS class_files_room ON class_files(room);

  -- class lists, students and their codes (codes are stored as keyed hashes only)
  CREATE TABLE IF NOT EXISTS rosters (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    roster_id TEXT NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    parent_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS students_roster ON students(roster_id);
  CREATE TABLE IF NOT EXISTS student_sessions (
    token_hash TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  -- homework, what students hand in, and files attached to either
  CREATE TABLE IF NOT EXISTS homework (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    roster_id TEXT NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS homework_roster ON homework(roster_id);
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    submitted_at INTEGER,
    mark TEXT NOT NULL DEFAULT '',
    feedback TEXT NOT NULL DEFAULT '',
    marked_at INTEGER,
    UNIQUE (homework_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS hw_files (
    id TEXT PRIMARY KEY,
    homework_id TEXT NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
    submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// columns added after 1.1
const addColumn = (table, column, def) => {
  if (!sql.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
};
addColumn('courses', 'waiting_room', 'INTEGER NOT NULL DEFAULT 0');
addColumn('courses', 'roster_id', 'TEXT REFERENCES rosters(id) ON DELETE SET NULL');
addColumn('attendance', 'student_id', 'TEXT');
addColumn('teachers', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
addColumn('teachers', 'last_login', 'INTEGER');
// One-time password reset codes, made by a school admin (or with `npm run reset-code`).
sql.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  teacher_id TEXT PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`);
// Every school needs an admin: if there is none yet, the oldest teacher account becomes one.
if (!sql.prepare('SELECT 1 FROM teachers WHERE is_admin = 1').get()) {
  sql.prepare('UPDATE teachers SET is_admin = 1 WHERE id = (SELECT id FROM teachers ORDER BY created_at LIMIT 1)').run();
}

const q = {
  teacherByUser: sql.prepare('SELECT * FROM teachers WHERE username = ?'),
  addTeacher: sql.prepare('INSERT INTO teachers (id, username, name, pass, created_at, is_admin) VALUES (?, ?, ?, ?, ?, ?)'),
  teacherCount: sql.prepare('SELECT COUNT(*) AS n FROM teachers'),
  claimOrphans: sql.prepare('UPDATE courses SET teacher_id = ? WHERE teacher_id IS NULL'),
  addSession: sql.prepare('INSERT INTO sessions (token_hash, teacher_id, expires_at) VALUES (?, ?, ?)'),
  session: sql.prepare('SELECT t.id, t.username, t.name, t.is_admin AS admin FROM sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token_hash = ? AND s.expires_at > ?'),
  delSession: sql.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  addCourse: sql.prepare(`INSERT INTO courses (id, series, room, teacher_id, title, date, start_time, end_time, subject, grp, teacher, notes, color, waiting_room, roster_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  editCourse: sql.prepare(`UPDATE courses SET title = ?, date = ?, start_time = ?, end_time = ?, subject = ?, grp = ?, notes = ?, color = ?, waiting_room = ?, roster_id = ?
    WHERE id = ? AND teacher_id = ?`),
  editSeries: sql.prepare(`UPDATE courses SET title = ?, start_time = ?, end_time = ?, subject = ?, grp = ?, notes = ?, color = ?, waiting_room = ?, roster_id = ?
    WHERE series = ? AND teacher_id = ?`),
  coursesByTeacher: sql.prepare('SELECT * FROM courses WHERE teacher_id = ? ORDER BY date, start_time'),
  coursesByRoster: sql.prepare('SELECT * FROM courses WHERE roster_id = ? ORDER BY date, start_time'),
  pupilSession: sql.prepare(`SELECT s.kind, st.id, st.name, st.roster_id AS rosterId, r.name AS rosterName, r.teacher_id AS teacherId
    FROM student_sessions s JOIN students st ON st.id = s.student_id JOIN rosters r ON r.id = st.roster_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  coursesByRoom: sql.prepare('SELECT * FROM courses WHERE room = ? ORDER BY date, start_time'),
  course: sql.prepare('SELECT * FROM courses WHERE id = ?'),
  delCourse: sql.prepare('DELETE FROM courses WHERE id = ? AND teacher_id = ?'),
  delSeries: sql.prepare('DELETE FROM courses WHERE series = ? AND teacher_id = ?'),
  courseOwner: sql.prepare('SELECT teacher_id, MAX(waiting_room) AS waiting FROM courses WHERE room = ? GROUP BY teacher_id LIMIT 1'),
  addInstant: sql.prepare('INSERT INTO instant_rooms (room, teacher_id, expires_at) VALUES (?, ?, ?)'),
  instantRoom: sql.prepare('SELECT teacher_id, expires_at FROM instant_rooms WHERE room = ?'),
  addAttendance: sql.prepare('INSERT INTO attendance (room, name, role, at, student_id) VALUES (?, ?, ?, ?, ?)'),
  attendance: sql.prepare('SELECT name, role, at, student_id FROM attendance WHERE room = ? ORDER BY at'),
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
          c.subject || '', c.group || '', c.teacher || '', c.notes || '', c.color || 'blue', 0, null);
      }
      for (const [room, list] of Object.entries(old.attendance || {})) {
        for (const a of list) q.addAttendance.run(room, a.name || '', a.role || 'student', Date.parse(a.at) || Date.now(), null);
      }
    });
    fs.renameSync(OLD_DB, OLD_DB + '.migrated');
    console.log('Imported data/db.json into SQLite (old file renamed to db.json.migrated).');
  } catch (e) {
    console.error('Could not import data/db.json:', e.message);
  }
}

// Shared class files live on disk in DATA_DIR/files, named by their random id.
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const filePath = (id) => path.join(FILES_DIR, id);
function deleteFiles(rows) {
  for (const f of rows) {
    fs.rm(filePath(f.id), { force: true }, () => {});
    sql.prepare('DELETE FROM class_files WHERE id = ?').run(f.id);
  }
}
// Files whose class no longer exists (every week deleted, or an old "start now" room).
const dropOrphanFiles = () => deleteFiles(sql.prepare(
  'SELECT id FROM class_files WHERE room NOT IN (SELECT room FROM courses) AND room NOT IN (SELECT room FROM instant_rooms)').all());

// Remove expired sessions, old instant rooms, old attendance records and orphaned files.
function prune() {
  const now = Date.now();
  sql.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  sql.prepare('DELETE FROM instant_rooms WHERE expires_at < ?').run(now - ATTENDANCE_DAYS * DAY);
  sql.prepare('DELETE FROM attendance WHERE at < ?').run(now - ATTENDANCE_DAYS * DAY);
  dropOrphanFiles();
  // files on disk that no table knows about (left over from a crash or a delete)
  const known = new Set([...sql.prepare('SELECT id FROM class_files').all(), ...sql.prepare('SELECT id FROM hw_files').all()].map((f) => f.id));
  for (const name of fs.readdirSync(FILES_DIR)) {
    if (known.has(name)) continue;
    try { if (now - fs.statSync(path.join(FILES_DIR, name)).mtimeMs > 3600e3) fs.rmSync(path.join(FILES_DIR, name), { force: true }); } catch {}
  }
}
prune();
setInterval(prune, 6 * 3600e3).unref();

// ---------- backups ----------
// Once a day, a copy of the database goes to DATA_DIR/backups; the newest BACKUP_DAYS copies are kept
// (0 turns daily backups off). Shared files are not in it. An admin can also download a copy.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = Math.max(parseInt(process.env.BACKUP_DAYS ?? '14', 10) || 0, 0);
const BACKUP_RE = /^cartable-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/;
// On Render without a disk, everything in DATA_DIR is erased at each deploy or restart.
const EPHEMERAL = !!process.env.RENDER && !process.env.DATA_DIR;
function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter((n) => BACKUP_RE.test(n)); } catch {}
  return names.map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, size: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}
// manual: a new file each time; daily: one file per day
function makeBackup(daily) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const iso = new Date().toISOString();
  const name = `cartable-${iso.slice(0, 10)}${daily ? '' : '-' + iso.slice(11, 19).replace(/:/g, '')}.db`;
  const file = path.join(BACKUP_DIR, name);
  fs.rmSync(file, { force: true });
  sql.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // keep the newest BACKUP_KEEP daily copies and the 5 newest manual ones
  const all = listBackups(), manual = (b) => /-\d{6}\.db$/.test(b.name);
  const old = [...all.filter((b) => !manual(b)).slice(Math.max(BACKUP_KEEP, 1)), ...all.filter(manual).slice(5)];
  for (const b of old) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
  return listBackups().find((b) => b.name === name);
}
function dailyBackup() {
  if (!BACKUP_KEEP) return;
  const today = `cartable-${new Date().toISOString().slice(0, 10)}.db`;
  if (fs.existsSync(path.join(BACKUP_DIR, today))) return;
  try { makeBackup(true); } catch (e) { console.error('Daily backup failed:', e.message); }
}
setTimeout(dailyBackup, 60e3).unref();
setInterval(dailyBackup, 3600e3).unref();
if (EPHEMERAL) console.warn('Warning: no disk is set (DATA_DIR). Accounts, classes and files are erased at each deploy or restart.');

const toCourse = (r) => ({
  id: r.id, series: r.series, room: r.room, title: r.title, date: r.date, start: r.start_time, end: r.end_time,
  subject: r.subject, group: r.grp, teacher: r.teacher, notes: r.notes, color: r.color, waitingRoom: !!r.waiting_room, rosterId: r.roster_id || null,
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
// A student or parent signed in with their code: { kind: 'student' | 'parent', id, name, rosterId, rosterName, teacherId }
function pupilFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return q.pupilSession.get(sha256(token), Date.now()) || null;
}

// ---------- student and parent codes ----------
// Student codes look like "k7pm-w3xa", parent codes like "p-x4kq9-m2rtw". They are random,
// stored only as an HMAC (so the database alone does not reveal them), and shown to the teacher once.
const CODE_SECRET = process.env.CODE_SECRET || (() => {
  const f = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
})();
const CODE_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const randChars = (n) => Array.from({ length: n }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join('');
const newStudentCode = () => `${randChars(4)}-${randChars(4)}`;
const newParentCode = () => `p-${randChars(5)}-${randChars(5)}`;
const normCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const codeHash = (c) => crypto.createHmac('sha256', CODE_SECRET).update(normCode(c)).digest('hex');

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
// Counts only failures, so a whole class signing in from one school address is not blocked.
function failCounter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return {
    blocked: (key) => { const h = hits.get(key); return !!h && h.reset > Date.now() && h.n >= max; },
    fail: (key) => {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
      h.n++;
    },
  };
}
const codeFails = failCounter(20, 15 * 60e3);
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
app.use('/api', (req, res, next) => {
  const token = bearer(req);
  req.teacher = teacherFromToken(token);
  req.pupil = req.teacher ? null : pupilFromToken(token);
  next();
});
const needTeacher = (req, res, next) => (req.teacher ? next() : res.status(401).json({ error: 'Please sign in as a teacher.' }));
const needSignedIn = (req, res, next) => (req.teacher || req.pupil ? next() : res.status(401).json({ error: 'Please sign in again.' }));

const needAdmin = (req, res, next) => (req.teacher?.admin ? next() : res.status(403).json({ error: 'Only a school admin can do this.' }));
const teacherView = (t) => ({ id: t.id, username: t.username, name: t.name, admin: !!(t.admin ?? t.is_admin) });

function startSession(res, t) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha256(token), t.id, Date.now() + SESSION_DAYS * DAY);
  sql.prepare('UPDATE teachers SET last_login = ? WHERE id = ?').run(Date.now(), t.id);
  res.json({ token, teacher: teacherView(t) });
}
const checkNewPassword = (pw) => (typeof pw !== 'string' || pw.length < 8 || pw.length > 200 ? 'Use a password of at least 8 characters.' : null);

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
  if (checkNewPassword(password)) return res.status(400).json({ error: checkNewPassword(password) });
  if (q.teacherByUser.get(username)) return res.status(409).json({ error: 'That username is taken. Pick another one.' });
  const t = { id: newId(), username, name, admin: false };
  tx(() => {
    // the first teacher of the school is its admin
    t.admin = q.teacherCount.get().n === 0;
    q.addTeacher.run(t.id, username, name, hashPassword(password), Date.now(), t.admin ? 1 : 0);
    if (t.admin) q.claimOrphans.run(t.id); // classes from before accounts existed go to the first teacher
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

// Students and parents sign in with the code their teacher gave them.
app.post('/api/auth/code', (req, res) => {
  if (codeFails.blocked(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const code = normCode(req.body && req.body.code);
  const kind = code.length === 8 ? 'student' : code.length === 11 && code[0] === 'p' ? 'parent' : null;
  const st = kind && sql.prepare(`SELECT st.*, r.name AS roster_name FROM students st JOIN rosters r ON r.id = st.roster_id
    WHERE ${kind === 'student' ? 'st.code_hash' : 'st.parent_hash'} = ?`).get(codeHash(code));
  if (!st) {
    codeFails.fail(req.ip);
    return res.status(401).json({ error: 'That code is not right. Check it with your teacher.' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sql.prepare('INSERT INTO student_sessions (token_hash, student_id, kind, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), st.id, kind, Date.now() + (kind === 'parent' ? 180 : 60) * DAY);
  res.json({ token, role: kind, name: st.name, studentId: st.id, rosterName: st.roster_name });
});

app.post('/api/auth/logout', (req, res) => {
  const token = bearer(req);
  if (token) {
    q.delSession.run(sha256(token));
    sql.prepare('DELETE FROM student_sessions WHERE token_hash = ?').run(sha256(token));
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', needSignedIn, (req, res) => {
  if (req.teacher) return res.json({ role: 'teacher', teacher: teacherView(req.teacher) });
  res.json({ role: req.pupil.kind, name: req.pupil.name, rosterName: req.pupil.rosterName });
});

// A teacher changes their own password. Every other device is signed out.
app.post('/api/auth/password', needTeacher, (req, res) => {
  if (!authLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const b = req.body || {};
  const t = sql.prepare('SELECT pass FROM teachers WHERE id = ?').get(req.teacher.id);
  if (!checkPassword(String(b.current || ''), t.pass)) return res.status(403).json({ error: 'Your current password is not right.' });
  const bad = checkNewPassword(b.password);
  if (bad) return res.status(400).json({ error: bad });
  tx(() => {
    sql.prepare('UPDATE teachers SET pass = ? WHERE id = ?').run(hashPassword(b.password), req.teacher.id);
    sql.prepare('DELETE FROM sessions WHERE teacher_id = ? AND token_hash != ?').run(req.teacher.id, sha256(bearer(req)));
  });
  res.json({ ok: true });
});

// A teacher who forgot their password uses the one-time reset code their school admin gave them.
// Reset codes look like "r7kp2-m4xqa" and are kept only as a hash, for 24 hours.
const newResetCode = () => `${randChars(5)}-${randChars(5)}`;
const resetHash = (c) => sha256('reset:' + normCode(c));
app.post('/api/auth/reset', (req, res) => {
  if (!authLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const b = req.body || {};
  const t = q.teacherByUser.get(String(b.username || '').trim().toLowerCase());
  const r = t && sql.prepare('SELECT code_hash FROM password_resets WHERE teacher_id = ? AND expires_at > ?').get(t.id, Date.now());
  const want = Buffer.from(r ? r.code_hash : sha256('none'), 'hex');
  const got = Buffer.from(resetHash(b.code), 'hex');
  if (!r || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'That username or reset code is not right. Ask your school admin for a new code.' });
  const bad = checkNewPassword(b.password);
  if (bad) return res.status(400).json({ error: bad });
  tx(() => {
    sql.prepare('UPDATE teachers SET pass = ? WHERE id = ?').run(hashPassword(b.password), t.id);
    sql.prepare('DELETE FROM password_resets WHERE teacher_id = ?').run(t.id);
    sql.prepare('DELETE FROM sessions WHERE teacher_id = ?').run(t.id);
  });
  startSession(res, t);
});

// ---------- school admin: teacher accounts and backups ----------
app.get('/api/admin/teachers', needTeacher, needAdmin, (req, res) => {
  const now = Date.now();
  res.json(sql.prepare(`SELECT t.id, t.username, t.name, t.is_admin, t.created_at, t.last_login,
      (SELECT COUNT(DISTINCT series) FROM courses c WHERE c.teacher_id = t.id) AS classes,
      (SELECT COUNT(*) FROM students st JOIN rosters r ON r.id = st.roster_id WHERE r.teacher_id = t.id) AS students,
      (SELECT expires_at FROM password_resets p WHERE p.teacher_id = t.id AND p.expires_at > ?) AS reset_until
    FROM teachers t ORDER BY t.name COLLATE NOCASE`).all(now).map((t) => ({
    ...teacherView(t), me: t.id === req.teacher.id, classes: t.classes, students: t.students,
    createdAt: new Date(t.created_at).toISOString(), lastLogin: t.last_login ? new Date(t.last_login).toISOString() : null,
    resetUntil: t.reset_until ? new Date(t.reset_until).toISOString() : null,
  })));
});
const otherTeacher = (req, res) => {
  const t = sql.prepare('SELECT * FROM teachers WHERE id = ?').get(String(req.params.id));
  if (!t) { res.status(404).json({ error: 'Teacher not found.' }); return null; }
  return t;
};
app.post('/api/admin/teachers/:id/reset', needTeacher, needAdmin, (req, res) => {
  const t = otherTeacher(req, res); if (!t) return;
  const code = newResetCode(), until = Date.now() + DAY;
  sql.prepare('INSERT INTO password_resets (teacher_id, code_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(teacher_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at')
    .run(t.id, resetHash(code), until);
  res.json({ code, username: t.username, name: t.name, until: new Date(until).toISOString() });
});
app.patch('/api/admin/teachers/:id', needTeacher, needAdmin, (req, res) => {
  const t = otherTeacher(req, res); if (!t) return;
  if (typeof req.body?.admin !== 'boolean') return res.status(400).json({ error: 'Something went wrong. Try again.' });
  if (t.id === req.teacher.id) return res.status(400).json({ error: 'Ask another admin to change your own role.' });
  sql.prepare('UPDATE teachers SET is_admin = ? WHERE id = ?').run(req.body.admin ? 1 : 0, t.id);
  res.json({ ok: true });
});
// Deleting a teacher deletes their classes, class lists, students and homework too.
app.delete('/api/admin/teachers/:id', needTeacher, needAdmin, (req, res) => {
  const t = otherTeacher(req, res); if (!t) return;
  if (t.id === req.teacher.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });
  for (const [room] of rooms) if (roomInfo(room)?.teacherId === t.id) endLiveRoom(room);
  sql.prepare('DELETE FROM teachers WHERE id = ?').run(t.id);
  dropOrphanFiles();
  res.json({ ok: true });
});

app.get('/api/admin/backups', needTeacher, needAdmin, (req, res) => {
  res.json({ list: listBackups(), keep: BACKUP_KEEP, auto: BACKUP_KEEP > 0, ephemeral: EPHEMERAL, dataDir: DATA_DIR });
});
app.post('/api/admin/backups', needTeacher, needAdmin, (req, res) => {
  try { res.status(201).json(makeBackup()); }
  catch (e) { console.error('Backup failed:', e.message); res.status(500).json({ error: 'The backup could not be made. Check the server log.' }); }
});
app.get('/api/admin/backups/:name', needTeacher, needAdmin, (req, res) => {
  const name = String(req.params.name);
  if (!BACKUP_RE.test(name) || !fs.existsSync(path.join(BACKUP_DIR, name))) return res.status(404).json({ error: 'Backup not found.' });
  res.set('x-content-type-options', 'nosniff');
  res.download(path.join(BACKUP_DIR, name), name);
});

// Teachers get their own classes. Students get their class list's classes plus any class whose
// code they have opened; parents get their child's class list's classes.
app.get('/api/courses', (req, res) => {
  if (req.teacher) return res.json(q.coursesByTeacher.all(req.teacher.id).map(toCourse));
  const list = req.pupil ? q.coursesByRoster.all(req.pupil.rosterId) : [];
  if (req.pupil?.kind !== 'parent') {
    const known = new Set(list.map((c) => c.id));
    const rooms = [...new Set(String(req.query.rooms || '').split(',').map((s) => s.trim()).filter((s) => ROOM_RE.test(s)))].slice(0, 50);
    for (const c of rooms.flatMap((r) => q.coursesByRoom.all(r))) if (!known.has(c.id)) list.push(c);
  }
  res.json(list.map(toCourse));
});

// A class list chosen in the class form must belong to this teacher.
function ownRosterId(req, b) {
  const id = b && typeof b.rosterId === 'string' ? b.rosterId : '';
  if (!id) return null;
  const r = sql.prepare('SELECT id FROM rosters WHERE id = ? AND teacher_id = ?').get(id, req.teacher.id);
  return r ? r.id : null;
}

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
  const rosterId = ownRosterId(req, req.body);
  f.rosterId = rosterId;
  const created = [];
  tx(() => {
    for (let w = 0; w < repeat; w++) {
      const d = new Date(f.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 7 * w);
      const c = { ...f, id: newId(), series, room, date: d.toISOString().slice(0, 10), teacher: req.teacher.name };
      q.addCourse.run(c.id, series, room, req.teacher.id, c.title, c.date, c.start, c.end, c.subject, c.group, c.teacher, c.notes, c.color, c.waitingRoom ? 1 : 0, rosterId);
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
  const rosterId = ownRosterId(req, req.body);
  if (all) q.editSeries.run(f.title, f.start, f.end, f.subject, f.group, f.notes, f.color, w, rosterId, c.series, req.teacher.id);
  else q.editCourse.run(f.title, f.date, f.start, f.end, f.subject, f.group, f.notes, f.color, w, rosterId, c.id, req.teacher.id);
  res.json({ ok: true });
});

app.delete('/api/courses/:id', needTeacher, (req, res) => {
  const c = q.course.get(req.params.id);
  if (!c || c.teacher_id !== req.teacher.id) return res.status(404).json({ error: 'Class not found.' });
  if (req.query.series === '1') q.delSeries.run(c.series, req.teacher.id);
  else q.delCourse.run(c.id, req.teacher.id);
  dropOrphanFiles();
  res.json({ ok: true });
});

app.get('/api/attendance/:room', needTeacher, (req, res) => {
  const info = roomInfo(req.params.room);
  if (!info || info.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Only the class teacher can see attendance.' });
  res.json(q.attendance.all(req.params.room).map((a) => ({ name: a.name, role: a.role, at: new Date(a.at).toISOString(), verified: !!a.student_id })));
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

// ---------- shared class files ----------
// Anyone with the class code can list and download; only the class teacher uploads and deletes.
const FILE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain; charset=utf-8', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4',
};
const MAX_FILE = 10 * 1024 * 1024, MAX_ROOM_FILES = 100 * 1024 * 1024;
const uploadLimit = limiter(60, 15 * 60e3);
const fileRow = (f) => ({ id: f.id, name: f.name, size: f.size, at: new Date(f.created_at).toISOString() });
// Check an uploaded file (raw body, name in the x-file-name header). Returns { error } or { name, ext, buf }.
function readUpload(req) {
  let name = '';
  try { name = decodeURIComponent(String(req.get('x-file-name') || '')); } catch {}
  name = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-120);
  const ext = (name.match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase();
  if (!name || !ext || !FILE_TYPES[ext]) return { error: 'This kind of file cannot be shared. Use a PDF, a picture, an office document, a sound or a video.' };
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'That file is empty.' };
  return { name, ext, buf };
}
function sendStoredFile(res, f) {
  res.set({
    'content-type': FILE_TYPES[f.ext] || 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=86400',
  });
  res.sendFile(filePath(f.id), (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'File not found.' }); });
}

app.get('/api/rooms/:room/files', (req, res) => {
  const room = req.params.room;
  if (!ROOM_RE.test(room) || !roomInfo(room)) {
    if (!roomLimit(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
    return res.status(404).json({ error: 'There is no class with this code. Check the code with your teacher.' });
  }
  res.json(sql.prepare('SELECT * FROM class_files WHERE room = ? ORDER BY created_at DESC').all(room).map(fileRow));
});

app.post('/api/rooms/:room/files', needTeacher, (req, res, next) => {
  if (!uploadLimit(req.teacher.id)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const info = ROOM_RE.test(req.params.room) && roomInfo(req.params.room);
  if (!info || info.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Only the class teacher can share files.' });
  next();
}, express.raw({ type: () => true, limit: MAX_FILE }), (req, res) => {
  const room = req.params.room;
  const up = readUpload(req);
  if (up.error) return res.status(400).json(up);
  const { name, ext, buf } = up;
  const used = sql.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM class_files WHERE room = ?').get(room).n;
  if (used + buf.length > MAX_ROOM_FILES) return res.status(413).json({ error: 'This class has no space left for files. Delete some old ones first.' });
  const id = newId();
  fs.writeFileSync(filePath(id), buf);
  const row = { id, name, size: buf.length, created_at: Date.now() };
  sql.prepare('INSERT INTO class_files (id, room, teacher_id, name, ext, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, room, req.teacher.id, name, ext, buf.length, row.created_at);
  io.to(room).emit('files-changed', { name });
  res.status(201).json(fileRow(row));
});

app.get('/api/files/:id', (req, res) => {
  const f = /^[0-9a-f]{16}$/.test(req.params.id) && sql.prepare('SELECT * FROM class_files WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found.' });
  sendStoredFile(res, f);
});

app.delete('/api/files/:id', needTeacher, (req, res) => {
  const f = /^[0-9a-f]{16}$/.test(req.params.id) && sql.prepare('SELECT * FROM class_files WHERE id = ?').get(req.params.id);
  if (!f || f.teacher_id !== req.teacher.id) return res.status(404).json({ error: 'File not found.' });
  deleteFiles([f]);
  io.to(f.room).emit('files-changed', {});
  res.json({ ok: true });
});

// ---------- class lists (rosters) ----------
const cleanName = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const myRoster = (req, id) => sql.prepare('SELECT * FROM rosters WHERE id = ? AND teacher_id = ?').get(String(id), req.teacher.id);
const rosterFileIds = (rosterId) => sql.prepare('SELECT f.id FROM hw_files f JOIN homework h ON h.id = f.homework_id WHERE h.roster_id = ?').all(rosterId);
const rmFiles = (rows) => rows.forEach((f) => fs.rm(filePath(f.id), { force: true }, () => {}));

// Give a student fresh codes. Old codes stop working and their sessions end.
function issueCodes(studentId, which) {
  const out = {};
  for (let tries = 0; tries < 5; tries++) {
    try {
      if (which !== 'parent') { out.code = newStudentCode(); sql.prepare('UPDATE students SET code_hash = ? WHERE id = ?').run(codeHash(out.code), studentId); }
      if (which !== 'student') { out.parentCode = newParentCode(); sql.prepare('UPDATE students SET parent_hash = ? WHERE id = ?').run(codeHash(out.parentCode), studentId); }
      break;
    } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; } // astronomically rare: try another code
  }
  if (which === 'both') sql.prepare('DELETE FROM student_sessions WHERE student_id = ?').run(studentId);
  else sql.prepare('DELETE FROM student_sessions WHERE student_id = ? AND kind = ?').run(studentId, which);
  return out;
}

app.get('/api/rosters', needTeacher, (req, res) => {
  res.json(sql.prepare(`SELECT r.id, r.name, (SELECT COUNT(*) FROM students s WHERE s.roster_id = r.id) AS students
    FROM rosters r WHERE r.teacher_id = ? ORDER BY r.name COLLATE NOCASE`).all(req.teacher.id));
});
app.post('/api/rosters', needTeacher, (req, res) => {
  const name = cleanName(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: 'Give the class list a name.' });
  const id = newId();
  sql.prepare('INSERT INTO rosters (id, teacher_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, req.teacher.id, name, Date.now());
  res.status(201).json({ id, name, students: 0 });
});
app.patch('/api/rosters/:id', needTeacher, (req, res) => {
  const r = myRoster(req, req.params.id);
  const name = cleanName(req.body?.name, 60);
  if (!r) return res.status(404).json({ error: 'Class list not found.' });
  if (!name) return res.status(400).json({ error: 'Give the class list a name.' });
  sql.prepare('UPDATE rosters SET name = ? WHERE id = ?').run(name, r.id);
  res.json({ ok: true });
});
app.delete('/api/rosters/:id', needTeacher, (req, res) => {
  const r = myRoster(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Class list not found.' });
  rmFiles(rosterFileIds(r.id));
  sql.prepare('DELETE FROM rosters WHERE id = ?').run(r.id); // students, homework and work handed in go with it
  res.json({ ok: true });
});

app.get('/api/rosters/:id/students', needTeacher, (req, res) => {
  const r = myRoster(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Class list not found.' });
  res.json(sql.prepare(`SELECT s.id, s.name,
      (SELECT MAX(at) FROM attendance a WHERE a.student_id = s.id) AS lastSeen
    FROM students s WHERE s.roster_id = ? ORDER BY s.name COLLATE NOCASE`).all(r.id)
    .map((s) => ({ ...s, lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null })));
});
// Add students (one name per line). Their codes are returned this once.
app.post('/api/rosters/:id/students', needTeacher, (req, res) => {
  const r = myRoster(req, req.params.id);
  if (!r) return res.status(404).json({ error: 'Class list not found.' });
  const names = (Array.isArray(req.body?.names) ? req.body.names : []).map((n) => cleanName(n, 30)).filter(Boolean).slice(0, 60);
  if (!names.length) return res.status(400).json({ error: 'Write at least one name.' });
  const count = sql.prepare('SELECT COUNT(*) AS n FROM students WHERE roster_id = ?').get(r.id).n;
  if (count + names.length > 60) return res.status(400).json({ error: 'A class list can have up to 60 students.' });
  const out = tx(() => names.map((name) => {
    const id = newId();
    // placeholder hashes are replaced by issueCodes right away
    sql.prepare('INSERT INTO students (id, roster_id, name, code_hash, parent_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, r.id, name, `x${newId()}`, `y${newId()}`, Date.now());
    return { id, name, ...issueCodes(id, 'both') };
  }));
  res.status(201).json(out);
});

const myStudent = (req, id) => sql.prepare('SELECT s.* FROM students s JOIN rosters r ON r.id = s.roster_id WHERE s.id = ? AND r.teacher_id = ?').get(String(id), req.teacher.id);
app.post('/api/students/:id/codes', needTeacher, (req, res) => {
  const s = myStudent(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  const which = ['student', 'parent', 'both'].includes(req.body?.which) ? req.body.which : 'both';
  res.json({ id: s.id, name: s.name, ...issueCodes(s.id, which) });
});
app.patch('/api/students/:id', needTeacher, (req, res) => {
  const s = myStudent(req, req.params.id);
  const name = cleanName(req.body?.name, 30);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  if (!name) return res.status(400).json({ error: 'Add a name.' });
  sql.prepare('UPDATE students SET name = ? WHERE id = ?').run(name, s.id);
  res.json({ ok: true });
});
app.delete('/api/students/:id', needTeacher, (req, res) => {
  const s = myStudent(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  rmFiles(sql.prepare('SELECT f.id FROM hw_files f JOIN submissions sb ON sb.id = f.submission_id WHERE sb.student_id = ?').all(s.id));
  sql.prepare('DELETE FROM students WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

// ---------- homework ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hwRow = (h) => ({ id: h.id, title: h.title, instructions: h.instructions, due: h.due, rosterId: h.roster_id, rosterName: h.roster_name, createdAt: new Date(h.created_at).toISOString() });
const subRow = (s) => s && ({
  id: s.id, text: s.text, submittedAt: s.submitted_at ? new Date(s.submitted_at).toISOString() : null,
  mark: s.mark, feedback: s.feedback, markedAt: s.marked_at ? new Date(s.marked_at).toISOString() : null,
});
const hwFiles = (homeworkId, submissionId) => sql.prepare(
  `SELECT * FROM hw_files WHERE homework_id = ? AND ${submissionId ? 'submission_id = ?' : 'submission_id IS NULL'} ORDER BY created_at`)
  .all(...(submissionId ? [homeworkId, submissionId] : [homeworkId])).map(fileRow);

// Who may see this homework, and as what: 'teacher' (who set it), 'student' or 'parent' (of its class list).
function homeworkAccess(req, id) {
  const h = sql.prepare('SELECT h.*, r.name AS roster_name FROM homework h JOIN rosters r ON r.id = h.roster_id WHERE h.id = ?').get(String(id));
  if (!h) return null;
  if (req.teacher && h.teacher_id === req.teacher.id) return { h, as: 'teacher' };
  if (req.pupil && req.pupil.rosterId === h.roster_id) return { h, as: req.pupil.kind };
  return null;
}
function homeworkFields(b) {
  const title = cleanName(b?.title, 100);
  const due = typeof b?.due === 'string' && DATE_RE.test(b.due) && !Number.isNaN(Date.parse(b.due)) ? b.due : null;
  if (!title || !due) return { error: 'Add a title and a due date.' };
  return { title, due, instructions: String(b.instructions || '').replace(/\r/g, '').slice(0, 4000) };
}

app.get('/api/homework', needSignedIn, (req, res) => {
  if (req.teacher) {
    return res.json(sql.prepare(`SELECT h.*, r.name AS roster_name,
        (SELECT COUNT(*) FROM students s WHERE s.roster_id = h.roster_id) AS total,
        (SELECT COUNT(*) FROM submissions s WHERE s.homework_id = h.id AND s.submitted_at IS NOT NULL) AS handed,
        (SELECT COUNT(*) FROM submissions s WHERE s.homework_id = h.id AND s.marked_at IS NOT NULL) AS marked
      FROM homework h JOIN rosters r ON r.id = h.roster_id WHERE h.teacher_id = ? ORDER BY h.due DESC, h.created_at DESC`)
      .all(req.teacher.id).map((h) => ({ ...hwRow(h), total: h.total, handed: h.handed, marked: h.marked })));
  }
  res.json(sql.prepare(`SELECT h.*, r.name AS roster_name, s.id AS sid, s.submitted_at, s.marked_at, s.mark
      FROM homework h JOIN rosters r ON r.id = h.roster_id
      LEFT JOIN submissions s ON s.homework_id = h.id AND s.student_id = ?
      WHERE h.roster_id = ? ORDER BY h.due DESC, h.created_at DESC`)
    .all(req.pupil.id, req.pupil.rosterId)
    .map((h) => ({ ...hwRow(h), submittedAt: h.submitted_at ? new Date(h.submitted_at).toISOString() : null, markedAt: h.marked_at ? new Date(h.marked_at).toISOString() : null, mark: h.marked_at ? h.mark : '' })));
});

app.post('/api/homework', needTeacher, (req, res) => {
  const r = myRoster(req, req.body?.rosterId);
  if (!r) return res.status(400).json({ error: 'Choose a class list.' });
  const f = homeworkFields(req.body);
  if (f.error) return res.status(400).json(f);
  const id = newId();
  sql.prepare('INSERT INTO homework (id, teacher_id, roster_id, title, instructions, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.teacher.id, r.id, f.title, f.instructions, f.due, Date.now());
  res.status(201).json({ id });
});
app.patch('/api/homework/:id', needTeacher, (req, res) => {
  const a = homeworkAccess(req, req.params.id);
  if (!a || a.as !== 'teacher') return res.status(404).json({ error: 'Homework not found.' });
  const f = homeworkFields(req.body);
  if (f.error) return res.status(400).json(f);
  sql.prepare('UPDATE homework SET title = ?, instructions = ?, due = ? WHERE id = ?').run(f.title, f.instructions, f.due, a.h.id);
  res.json({ ok: true });
});
app.delete('/api/homework/:id', needTeacher, (req, res) => {
  const a = homeworkAccess(req, req.params.id);
  if (!a || a.as !== 'teacher') return res.status(404).json({ error: 'Homework not found.' });
  rmFiles(sql.prepare('SELECT id FROM hw_files WHERE homework_id = ?').all(a.h.id));
  sql.prepare('DELETE FROM homework WHERE id = ?').run(a.h.id);
  res.json({ ok: true });
});

app.get('/api/homework/:id', needSignedIn, (req, res) => {
  const a = homeworkAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'Homework not found.' });
  const out = { ...hwRow(a.h), files: hwFiles(a.h.id), as: a.as };
  if (a.as === 'teacher') {
    out.students = sql.prepare(`SELECT st.id, st.name, s.id AS sid, s.submitted_at, s.marked_at, s.mark
        FROM students st LEFT JOIN submissions s ON s.student_id = st.id AND s.homework_id = ?
        WHERE st.roster_id = ? ORDER BY st.name COLLATE NOCASE`).all(a.h.id, a.h.roster_id)
      .map((s) => ({ id: s.id, name: s.name, submissionId: s.sid, submittedAt: s.submitted_at ? new Date(s.submitted_at).toISOString() : null, markedAt: s.marked_at ? new Date(s.marked_at).toISOString() : null, mark: s.mark || '' }));
  } else {
    const s = sql.prepare('SELECT * FROM submissions WHERE homework_id = ? AND student_id = ?').get(a.h.id, req.pupil.id);
    out.submission = s ? { ...subRow(s), files: hwFiles(a.h.id, s.id) } : null;
    if (out.submission && !s.marked_at) { out.submission.mark = ''; out.submission.feedback = ''; }
  }
  res.json(out);
});

// the teacher opens one student's work
app.get('/api/submissions/:id', needTeacher, (req, res) => {
  const s = sql.prepare('SELECT * FROM submissions WHERE id = ?').get(String(req.params.id));
  const a = s && homeworkAccess(req, s.homework_id);
  if (!a || a.as !== 'teacher') return res.status(404).json({ error: 'Homework not found.' });
  const st = sql.prepare('SELECT name FROM students WHERE id = ?').get(s.student_id);
  res.json({ ...subRow(s), student: st?.name || '', files: hwFiles(s.homework_id, s.id) });
});
app.patch('/api/submissions/:id', needTeacher, (req, res) => {
  const s = sql.prepare('SELECT * FROM submissions WHERE id = ?').get(String(req.params.id));
  const a = s && homeworkAccess(req, s.homework_id);
  if (!a || a.as !== 'teacher') return res.status(404).json({ error: 'Homework not found.' });
  const mark = cleanName(req.body?.mark, 20), feedback = String(req.body?.feedback || '').replace(/\r/g, '').slice(0, 2000);
  if (!mark && !feedback.trim()) return res.status(400).json({ error: 'Add a mark or a comment.' });
  sql.prepare('UPDATE submissions SET mark = ?, feedback = ?, marked_at = ? WHERE id = ?').run(mark, feedback, Date.now(), s.id);
  res.json({ ok: true });
});

// students: save work, and hand it in (or take it back) until it is marked
function mySubmission(req, homeworkId) {
  let s = sql.prepare('SELECT * FROM submissions WHERE homework_id = ? AND student_id = ?').get(homeworkId, req.pupil.id);
  if (!s) {
    sql.prepare('INSERT INTO submissions (id, homework_id, student_id) VALUES (?, ?, ?)').run(newId(), homeworkId, req.pupil.id);
    s = sql.prepare('SELECT * FROM submissions WHERE homework_id = ? AND student_id = ?').get(homeworkId, req.pupil.id);
  }
  return s;
}
app.put('/api/homework/:id/submission', needSignedIn, (req, res) => {
  const a = homeworkAccess(req, req.params.id);
  if (!a || a.as !== 'student') return res.status(404).json({ error: 'Homework not found.' });
  const s = mySubmission(req, a.h.id);
  if (s.marked_at) return res.status(409).json({ error: 'Your teacher has already marked this homework.' });
  const text = String(req.body?.text || '').replace(/\r/g, '').slice(0, 10000);
  const handIn = req.body?.handIn === true ? Date.now() : req.body?.handIn === false ? null : s.submitted_at;
  sql.prepare('UPDATE submissions SET text = ?, submitted_at = ? WHERE id = ?').run(text, handIn, s.id);
  res.json({ ok: true, submittedAt: handIn ? new Date(handIn).toISOString() : null });
});

// files: the teacher attaches to the homework, a student attaches to their own work
const MAX_HW_FILES = 10;
app.post('/api/homework/:id/files', needSignedIn, (req, res, next) => {
  const a = homeworkAccess(req, req.params.id);
  if (!a || a.as === 'parent') return res.status(404).json({ error: 'Homework not found.' });
  if (!uploadLimit(req.teacher ? req.teacher.id : req.pupil.id)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  req.hw = a;
  next();
}, express.raw({ type: () => true, limit: MAX_FILE }), (req, res) => {
  const a = req.hw;
  let submissionId = null;
  if (a.as === 'student') {
    const s = mySubmission(req, a.h.id);
    if (s.marked_at) return res.status(409).json({ error: 'Your teacher has already marked this homework.' });
    submissionId = s.id;
  }
  const n = sql.prepare(`SELECT COUNT(*) AS n FROM hw_files WHERE homework_id = ? AND ${submissionId ? 'submission_id = ?' : 'submission_id IS NULL'}`)
    .get(...(submissionId ? [a.h.id, submissionId] : [a.h.id])).n;
  if (n >= MAX_HW_FILES) return res.status(400).json({ error: 'You can attach up to 10 files.' });
  const up = readUpload(req);
  if (up.error) return res.status(400).json(up);
  const id = newId(), at = Date.now();
  fs.writeFileSync(filePath(id), up.buf);
  sql.prepare('INSERT INTO hw_files (id, homework_id, submission_id, name, ext, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.h.id, submissionId, up.name, up.ext, up.buf.length, at);
  res.status(201).json(fileRow({ id, name: up.name, size: up.buf.length, created_at: at }));
});
// Homework files need the session token, so the app downloads them with fetch.
function hwFileAccess(req, id) {
  const f = /^[0-9a-f]{16}$/.test(String(id)) && sql.prepare('SELECT * FROM hw_files WHERE id = ?').get(String(id));
  const a = f && homeworkAccess(req, f.homework_id);
  if (!a) return null;
  if (!f.submission_id || a.as === 'teacher') return { f, a };
  const s = sql.prepare('SELECT student_id, marked_at FROM submissions WHERE id = ?').get(f.submission_id);
  return s && req.pupil && s.student_id === req.pupil.id ? { f, a, s } : null;
}
app.get('/api/hwfiles/:id', needSignedIn, (req, res) => {
  const x = hwFileAccess(req, req.params.id);
  if (!x) return res.status(404).json({ error: 'File not found.' });
  sendStoredFile(res, x.f);
});
app.delete('/api/hwfiles/:id', needSignedIn, (req, res) => {
  const x = hwFileAccess(req, req.params.id);
  const mine = x && ((x.a.as === 'teacher' && !x.f.submission_id) || (x.a.as === 'student' && x.s && !x.s.marked_at));
  if (!mine) return res.status(404).json({ error: 'File not found.' });
  rmFiles([x.f]);
  sql.prepare('DELETE FROM hw_files WHERE id = ?').run(x.f.id);
  res.json({ ok: true });
});

// parents (and students) see which classes the child joined
app.get('/api/my/attendance', needSignedIn, (req, res) => {
  if (!req.pupil) return res.json([]);
  res.json(sql.prepare(`SELECT a.at, a.room, (SELECT c.title FROM courses c WHERE c.room = a.room LIMIT 1) AS title
      FROM attendance a WHERE a.student_id = ? ORDER BY a.at DESC LIMIT 300`).all(req.pupil.id)
    .map((a) => ({ at: new Date(a.at).toISOString(), title: a.title || '' })));
});

// Body too big: answer in JSON so the app can show a friendly message.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: req.path.endsWith('/background') ? 'That picture is too big. Try a smaller one.' : 'That file is too big (10 MB max).' });
  }
  next(err);
});

// ---------- live rooms (WebRTC signaling) ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e5 });

// room -> { peers: Map<socketId, {name, role, hand, mic, cam}>, lobby: Map<socketId, {name, admit}>,
//           locked, boardLocked, waiting, strokes: [{ s, by }], points, bg, recording }
const rooms = new Map();
function getRoom(id, info) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      peers: new Map(), lobby: new Map(), locked: false, boardLocked: false, waiting: !!info?.waiting, strokes: [], points: 0, bg: null, recording: null, poll: null, groups: null,
      // chat: 'all' (everyone writes), 'teacher' (students write to the teacher only) or 'off' (only the teacher writes)
      chat: 'all', chatMuted: new Set(), pupilIds: new Map(),
    });
  }
  return rooms.get(id);
}
const peerList = (r) => [...r.peers].map(([id, p]) => ({ id, ...p }));
const lobbyList = (r) => [...r.lobby].map(([id, p]) => ({ id, name: p.name }));
const flags = (r) => ({ locked: r.locked, boardLocked: r.boardLocked, waiting: r.waiting, chat: r.chat });
const CHAT_MODES = ['all', 'teacher', 'off'];
// Send everyone to the end-of-class screen (the teacher ended it, or their account was deleted).
function endLiveRoom(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  io.to(roomId).emit('ended');
  [...r.lobby.keys()].forEach((id) => io.to(id).emit('ended'));
  if (LK) [null, ...Array.from({ length: 8 }, (_, i) => i)].forEach((g) => lkClose(lkRoomName(roomId, g)));
}

// ---- polls: one at a time per class; only the teacher sees results until they are shown ----
function pollView(r, forTeacher) {
  const p = r.poll;
  if (!p) return null;
  const counts = p.options.map(() => 0);
  for (const v of p.votes.values()) counts[v.choice]++;
  const show = forTeacher || p.shown;
  return {
    id: p.id, q: p.q, options: p.options, quiz: p.correct !== null, open: p.open, shown: p.shown, total: p.votes.size,
    counts: show ? counts : null, correct: show ? p.correct : null,
    ...(forTeacher ? { voters: [...p.votes.values()].map((v) => ({ name: v.name, choice: v.choice })) } : {}),
  };
}
function sendPoll(r, roomId, teachersOnly) {
  for (const [id, p] of r.peers) {
    if (p.role === 'teacher') io.to(id).emit('poll', pollView(r, true));
    else if (!teachersOnly) io.to(id).emit('poll', pollView(r, false));
  }
}

// ---- breakout groups: r.groups maps socket id -> group number; everyone else is in the main room (null) ----
const groupOf = (r, id) => (r.groups ? (r.groups.has(id) ? r.groups.get(id) : null) : null);
const breakoutView = (r) => (r.groups ? { active: true, count: r.groupCount, groups: Object.fromEntries(r.groups) } : { active: false });
const sendBreakout = (r, roomId) => io.to(roomId).emit('breakout', breakoutView(r));
// With LiveKit, a group is its own LiveKit room. When people change group, give each of them a
// token for their new room only, and remove them from the old one.
const lkSnapshot = (r, roomId) => new Map([...r.peers.keys()].map((id) => [id, lkRoomName(roomId, groupOf(r, id))]));
function lkRegroup(r, roomId, before) {
  if (!LK) return;
  for (const [id, p] of r.peers) {
    const now = lkRoomName(roomId, groupOf(r, id));
    if (before.get(id) === now) continue;
    io.to(id).emit('lk-token', { url: LK.url, token: lkJoinToken(now, id, p.name) });
    if (before.has(id)) lkKick(before.get(id), id);
  }
}
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
    const pupil = t ? null : pupilFromToken(token);
    if (pupil && pupil.kind === 'parent') return reply({ error: 'Parents can follow classes from their own page, but cannot join them.' });
    const r = getRoom(room, info);
    if (r.locked && !teacher) { dropRoomIfEmpty(room); return reply({ error: 'The teacher has locked this class. Ask them to unlock it.' }); }
    // students signed in with their code always appear with their class-list name
    const myName = (teacher ? t.name : pupil ? pupil.name : String(name || '').trim()).slice(0, 30) || 'Guest';

    // Put this person in the class. Returns the welcome message, or an error if the class is full.
    const enter = () => {
      if (r.peers.size >= MAX_PEOPLE) return { error: 'This class is full ({n} people max).', n: MAX_PEOPLE };
      me = { name: myName, role: teacher ? 'teacher' : 'student', verified: teacher || !!pupil, hand: false, mic: true, cam: true,
        chatMuted: !teacher && !!pupil && r.chatMuted.has('s:' + pupil.id) };
      if (pupil) r.pupilIds.set(socket.id, pupil.id);
      socket.join(room);
      const others = peerList(r);
      r.peers.set(socket.id, me);
      q.addAttendance.run(room, me.name, me.role, Date.now(), pupil ? pupil.id : null);
      socket.to(room).emit('peer-joined', { id: socket.id, ...me });
      return {
        ok: true, id: socket.id, role: me.role, name: me.name, peers: others, strokes: r.strokes.map((x) => x.s),
        ...flags(r), chatMuted: me.chatMuted, recording: !!r.recording, bg: r.bg ? r.bg.v : 0, lobby: teacher ? lobbyList(r) : [],
        poll: pollView(r, teacher), breakout: breakoutView(r),
        // newcomers start in the main room, so their LiveKit token is for it
        media: LK ? 'livekit' : 'mesh',
        ...(LK ? { lk: { url: LK.url, token: lkJoinToken(lkRoomName(room, null), socket.id, me.name) } } : {}),
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

  on('chat', (text, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!roomId || !me || typeof text !== 'string' || !chatLimit(1)) return reply({ ok: false });
    const t = text.trim().slice(0, 500);
    if (!t) return reply({ ok: false });
    const r = getRoom(roomId);
    const student = me.role !== 'teacher';
    if (student && me.chatMuted) return reply({ error: 'The teacher turned off your messages.' });
    if (student && r.chat === 'off') return reply({ error: 'Only the teacher can write in the chat right now.' });
    const msg = { id: crypto.randomBytes(6).toString('hex'), from: socket.id, name: me.name, role: me.role, text: t, at: Date.now() };
    reply({ ok: true });
    // "students write to the teacher only": the message goes to the teachers and back to its writer
    if (student && r.chat === 'teacher') {
      msg.private = true;
      for (const [id, p] of r.peers) if (id === socket.id || p.role === 'teacher') io.to(id).emit('chat', msg);
      return;
    }
    if (!r.groups) return io.to(roomId).emit('chat', msg);
    // During group work, messages stay in the group. Teachers read every group, and a
    // teacher writing from the main room speaks to everyone.
    const g = groupOf(r, socket.id);
    msg.group = g;
    msg.toAll = me.role === 'teacher' && g === null;
    for (const [id, p] of r.peers) {
      if (msg.toAll || p.role === 'teacher' || groupOf(r, id) === g) io.to(id).emit('chat', msg);
    }
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

  // answer the poll (students); the answer can change while voting is open
  on('vote', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!roomId || !me || me.role === 'teacher' || !isObj(msg) || !reactLimit(1)) return reply({ ok: false });
    const r = getRoom(roomId);
    const p = r.poll;
    if (!p || !p.open || msg.id !== p.id || !Number.isInteger(msg.choice) || msg.choice < 0 || msg.choice >= p.options.length) return reply({ ok: false });
    p.votes.set(socket.id, { name: me.name, choice: msg.choice });
    sendPoll(r, roomId, true);
    reply({ ok: true });
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
      case 'remove':
        if (has) {
          lkKick(lkRoomName(roomId, groupOf(r, target)), target); // also cut their video, not just the app
          io.to(target).emit('removed');
          io.sockets.sockets.get(target)?.disconnect(true);
        }
        break;
      case 'end': endLiveRoom(roomId); break;

      case 'chat-mode':
        if (CHAT_MODES.includes(msg.mode)) { r.chat = msg.mode; io.to(roomId).emit('room-flags', flags(r)); }
        break;
      // stop (or allow again) one student's messages; students signed in with a code stay muted if they come back
      case 'chat-mute': {
        const p = has && r.peers.get(target);
        if (!p || p.role === 'teacher') return;
        p.chatMuted = !p.chatMuted;
        const keys = [target, r.pupilIds.has(target) && 's:' + r.pupilIds.get(target)].filter(Boolean);
        keys.forEach((k) => (p.chatMuted ? r.chatMuted.add(k) : r.chatMuted.delete(k)));
        io.to(roomId).emit('peer-state', { id: target, ...p });
        io.to(target).emit('chat-muted', p.chatMuted);
        break;
      }
      case 'chat-delete':
        if (typeof msg.id === 'string' && /^[0-9a-f]{12}$/.test(msg.id)) io.to(roomId).emit('chat-delete', msg.id);
        break;
      case 'record-start': r.recording = socket.id; io.to(roomId).emit('recording', { on: true, name: me.name }); break;
      case 'record-stop': if (r.recording) { r.recording = null; io.to(roomId).emit('recording', { on: false }); } break;

      case 'poll-start': {
        const q = typeof msg.q === 'string' ? msg.q.trim().slice(0, 200) : '';
        const options = Array.isArray(msg.options) ? msg.options.filter((o) => typeof o === 'string').map((o) => o.trim().slice(0, 80)).filter(Boolean) : [];
        if (!q || options.length < 2 || options.length > 6) return;
        const correct = Number.isInteger(msg.correct) && msg.correct >= 0 && msg.correct < options.length ? msg.correct : null;
        r.poll = { id: newId(), q, options, correct, votes: new Map(), open: true, shown: false };
        sendPoll(r, roomId);
        break;
      }
      case 'poll-close': if (r.poll) { r.poll.open = false; sendPoll(r, roomId); } break;
      case 'poll-show': if (r.poll) { r.poll.open = false; r.poll.shown = true; sendPoll(r, roomId); } break;
      case 'poll-end': r.poll = null; io.to(roomId).emit('poll', null); break;

      case 'breakout-start': {
        const count = Number(msg.count);
        if (!Number.isInteger(count) || count < 2 || count > 8 || !isObj(msg.assign)) return;
        const before = lkSnapshot(r, roomId);
        r.groups = new Map();
        r.groupCount = count;
        for (const [id, g] of Object.entries(msg.assign)) {
          if (r.peers.has(id) && Number.isInteger(g) && g >= 0 && g < count) r.groups.set(id, g);
        }
        sendBreakout(r, roomId);
        lkRegroup(r, roomId, before);
        break;
      }
      case 'breakout-move': {
        const g = msg.group;
        if (!r.groups || typeof target !== 'string' || !r.peers.has(target)) return;
        const before = lkSnapshot(r, roomId);
        if (g === null) r.groups.delete(target);
        else if (Number.isInteger(g) && g >= 0 && g < r.groupCount) r.groups.set(target, g);
        else return;
        sendBreakout(r, roomId);
        lkRegroup(r, roomId, before);
        break;
      }
      case 'breakout-end':
        if (r.groups) {
          const before = lkSnapshot(r, roomId);
          r.groups = null;
          sendBreakout(r, roomId);
          lkRegroup(r, roomId, before);
        }
        break;
    }
  });

  on('disconnect', () => {
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;
    if (r.lobby.delete(socket.id)) sendLobby(r);
    if (r.peers.has(socket.id)) lkKick(lkRoomName(roomId, groupOf(r, socket.id)), socket.id);
    r.pupilIds.delete(socket.id);
    if (r.peers.delete(socket.id)) {
      if (r.recording === socket.id) { r.recording = null; socket.to(roomId).emit('recording', { on: false }); }
      if (r.groups && r.groups.delete(socket.id)) sendBreakout(r, roomId);
      socket.to(roomId).emit('peer-left', { id: socket.id });
    }
    dropRoomIfEmpty(roomId);
  });
});

server.listen(PORT, () => {
  // the real port (PORT=0 picks a free one, which the tests use)
  console.log(`Cartable is running on http://localhost:${server.address().port}`);
  console.log(LK ? `Video goes through LiveKit at ${LK.url} (up to ${MAX_PEOPLE} people per class).` : 'Video goes directly between browsers (up to 16 people per class).');
  if (SCHOOL_CODE === 'teach') {
    if (PROD) console.warn('WARNING: TEACHER_CODE is not set, so new teacher accounts are turned off. Set a secret TEACHER_CODE.');
    else console.log('School code is "teach" (needed to create teacher accounts). Set TEACHER_CODE to change it.');
  }
});
