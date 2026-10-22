require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const email = process.env.ADMIN_EMAIL || process.argv[2];
const password = process.env.ADMIN_PASSWORD || process.argv[3];
const name = process.env.ADMIN_NAME || process.argv[4] || 'Administrator';

if (!email || !password) {
  console.error('Usage: node server/init-admin.js <email> <password> [name]');
  console.error('Or set ADMIN_EMAIL and ADMIN_PASSWORD in .env');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare('UPDATE admins SET password_hash = ?, name = ? WHERE id = ?').run(hash, name, existing.id);
  console.log('Admin updated:', email.toLowerCase());
} else {
  db.prepare('INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)').run(email.toLowerCase(), hash, name);
  console.log('Admin created:', email.toLowerCase());
}
