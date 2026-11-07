'use strict';
/* Grant admin role: npm run make-admin -- <LINE userId | user id>   (user must have logged in once) */
const { db } = require('../src/db');
const arg = process.argv[2];
if (!arg) { console.log('Usage: npm run make-admin -- <LINE userId (U...) or numeric user id>'); process.exit(1); }
const u = db.prepare('SELECT * FROM users WHERE line_user_id = ? OR id = ?').get(arg, Number(arg) || -1);
if (!u) { console.error('User not found. Log in once via LINE first, then run again.'); process.exit(1); }
db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id);
console.log(`✓ ${u.display_name} (${u.line_user_id}) is now an admin.`);
