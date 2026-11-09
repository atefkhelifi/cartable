// Cartable — open-source online classroom (MIT License)
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TEACHER_CODE = String(process.env.TEACHER_CODE || 'teach').trim();
const codeOk = (c) => typeof c === 'string' && c.trim() === TEACHER_CODE;
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

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

// ---------- tiny JSON store ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { courses: [], attendance: {} }; }
}
let db = loadDb();
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const newId = () => crypto.randomBytes(4).toString('hex');
const roomCode = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 9; i++) s += a[crypto.randomInt(a.length)] + (i === 2 || i === 5 ? '-' : '');
  return s;
};

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/config', (req, res) => res.json({ iceServers: ICE_SERVERS }));
app.use(express.static(path.join(__dirname, 'public')));

const isTeacher = (req) => codeOk(req.get('x-teacher-code') || '');

app.post('/api/teacher/verify', (req, res) => {
  res.json({ ok: codeOk(req.body && req.body.code) });
});

app.get('/api/courses', (req, res) => res.json(db.courses));

app.post('/api/courses', (req, res) => {
  if (!isTeacher(req)) return res.status(403).json({ error: 'Only teachers can create classes.' });
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 80);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end)) {
    return res.status(400).json({ error: 'Add a title, a date, a start time and an end time.' });
  }
  if (b.end <= b.start) return res.status(400).json({ error: 'The class must end after it starts.' });
  const repeat = Math.min(Math.max(parseInt(b.repeatWeeks, 10) || 1, 1), 40);
  const series = newId();
  const room = roomCode();
  const created = [];
  for (let w = 0; w < repeat; w++) {
    const d = new Date(b.date + 'T00:00:00');
    d.setDate(d.getDate() + 7 * w);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const course = {
      id: newId(), series, room, title, date, start: b.start, end: b.end,
      subject: String(b.subject || '').slice(0, 40),
      group: String(b.group || '').slice(0, 40),
      teacher: String(b.teacher || 'Teacher').slice(0, 40),
      notes: String(b.notes || '').slice(0, 500),
      color: ['blue', 'green', 'yellow', 'red', 'purple', 'orange'].includes(b.color) ? b.color : 'blue',
    };
    db.courses.push(course);
    created.push(course);
  }
  saveDb();
  res.status(201).json(created);
});

app.delete('/api/courses/:id', (req, res) => {
  if (!isTeacher(req)) return res.status(403).json({ error: 'Only teachers can delete classes.' });
  const all = req.query.series === '1';
  const c = db.courses.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  db.courses = db.courses.filter((x) => (all ? x.series !== c.series : x.id !== c.id));
  saveDb();
  res.json({ ok: true });
});

app.get('/api/attendance/:room', (req, res) => {
  if (!isTeacher(req)) return res.status(403).json({ error: 'Only teachers can see attendance.' });
  res.json(db.attendance[req.params.room] || []);
});

app.get('/api/new-room', (req, res) => res.json({ room: roomCode() }));

// ---------- live rooms (WebRTC signaling) ----------
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// room -> { peers: Map<socketId, {name, role, hand, mic, cam}>, locked, boardLocked, strokes: [] }
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { peers: new Map(), locked: false, boardLocked: false, strokes: [] });
  return rooms.get(id);
}
const peerList = (r) => [...r.peers].map(([id, p]) => ({ id, ...p }));

io.on('connection', (socket) => {
  let roomId = null;
  let me = null;

  socket.on('join', ({ room, name, role, teacherCode }, ack) => {
    if (typeof room !== 'string' || !/^[a-z0-9-]{3,20}$/.test(room)) return ack && ack({ error: 'This class link is not valid.' });
    const r = getRoom(room);
    const teacher = role === 'teacher' && codeOk(teacherCode);
    if (r.locked && !teacher) return ack && ack({ error: 'The teacher has locked this class. Ask them to unlock it.' });
    if (r.peers.size >= 16) return ack && ack({ error: 'This class is full (16 people max).' });
    roomId = room;
    me = { name: String(name || 'Guest').slice(0, 30), role: teacher ? 'teacher' : 'student', hand: false, mic: true, cam: true };
    socket.join(room);
    const others = peerList(r);
    r.peers.set(socket.id, me);
    (db.attendance[room] = db.attendance[room] || []).push({ name: me.name, role: me.role, at: new Date().toISOString() });
    saveDb();
    socket.to(room).emit('peer-joined', { id: socket.id, ...me });
    ack && ack({ ok: true, id: socket.id, role: me.role, peers: others, strokes: r.strokes, locked: r.locked, boardLocked: r.boardLocked });
  });

  // relay WebRTC signals to one peer
  socket.on('signal', ({ to, data }) => {
    if (!roomId || !getRoom(roomId).peers.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', (text) => {
    if (!roomId || !me) return;
    const t = String(text || '').trim().slice(0, 500);
    if (t) io.to(roomId).emit('chat', { from: socket.id, name: me.name, role: me.role, text: t, at: Date.now() });
  });

  socket.on('state', (patch) => {
    if (!roomId || !me) return;
    for (const k of ['hand', 'mic', 'cam', 'sharing']) if (k in patch) me[k] = !!patch[k];
    io.to(roomId).emit('peer-state', { id: socket.id, ...me });
  });

  socket.on('react', (emoji) => {
    if (!roomId || !me) return;
    if (['👍', '👏', '❤️', '😂', '🎉', '❓'].includes(emoji)) io.to(roomId).emit('react', { id: socket.id, name: me.name, emoji });
  });

  socket.on('draw', (stroke) => {
    if (!roomId || !me) return;
    const r = getRoom(roomId);
    if (r.boardLocked && me.role !== 'teacher') return;
    if (r.strokes.length > 5000) r.strokes.shift();
    r.strokes.push(stroke);
    socket.to(roomId).emit('draw', stroke);
  });

  // teacher-only controls
  socket.on('teacher', ({ action, target }) => {
    if (!roomId || !me || me.role !== 'teacher') return;
    const r = getRoom(roomId);
    switch (action) {
      case 'clear-board': r.strokes = []; io.to(roomId).emit('clear-board'); break;
      case 'lock': r.locked = !r.locked; io.to(roomId).emit('room-flags', { locked: r.locked, boardLocked: r.boardLocked }); break;
      case 'lock-board': r.boardLocked = !r.boardLocked; io.to(roomId).emit('room-flags', { locked: r.locked, boardLocked: r.boardLocked }); break;
      case 'mute-all': socket.to(roomId).emit('force-mute'); break;
      case 'mute': if (r.peers.has(target)) io.to(target).emit('force-mute'); break;
      case 'lower-hand': if (r.peers.has(target)) io.to(target).emit('force-lower-hand'); break;
      case 'remove': if (r.peers.has(target)) { io.to(target).emit('removed'); io.sockets.sockets.get(target)?.disconnect(true); } break;
      case 'end': io.to(roomId).emit('ended'); break;
    }
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const r = getRoom(roomId);
    r.peers.delete(socket.id);
    socket.to(roomId).emit('peer-left', { id: socket.id });
    if (r.peers.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Cartable is running on http://localhost:${PORT}`);
  if (TEACHER_CODE === 'teach') console.log('Teacher code is "teach". Set TEACHER_CODE to change it.');
  if (TEACHER_CODE === 'teach' && process.env.NODE_ENV === 'production') console.warn('WARNING: set a secret TEACHER_CODE before letting students in.');
});
