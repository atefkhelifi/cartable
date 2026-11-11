// Make a one-time password reset code for a teacher, for when no admin can sign in.
//   npm run reset-code -- <username>            a reset code, valid 24 hours
//   npm run reset-code -- <username> --admin    the same, and make them a school admin
// Run it on the server, with the same DATA_DIR as Cartable. The teacher then chooses
// "Forgot your password?" on the sign-in page and types the code.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const username = String(process.argv[2] || '').trim().toLowerCase();
const makeAdmin = process.argv.includes('--admin');
if (!username || username.startsWith('-')) {
  console.error('Usage: npm run reset-code -- <username> [--admin]');
  process.exit(1);
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const sql = new DatabaseSync(path.join(DATA_DIR, 'cartable.db'));
const t = sql.prepare('SELECT id, name FROM teachers WHERE username = ?').get(username);
if (!t) {
  console.error(`No teacher with the username "${username}".`);
  process.exit(1);
}
// same format and hash as server.js
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const chars = (n) => Array.from({ length: n }, () => ABC[crypto.randomInt(ABC.length)]).join('');
const code = `${chars(5)}-${chars(5)}`;
const hash = crypto.createHash('sha256').update('reset:' + code.replace(/[^a-z0-9]/g, '')).digest('hex');
sql.prepare(`INSERT INTO password_resets (teacher_id, code_hash, expires_at) VALUES (?, ?, ?)
  ON CONFLICT(teacher_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`).run(t.id, hash, Date.now() + 24 * 3600e3);
if (makeAdmin) sql.prepare('UPDATE teachers SET is_admin = 1 WHERE id = ?').run(t.id);
console.log(`Reset code for ${t.name} (${username}): ${code}`);
console.log('It works once, for 24 hours.' + (makeAdmin ? ' They are now a school admin.' : ''));
