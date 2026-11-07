'use strict';
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const line = require('../lib/line');
const { audit } = require('../lib/audit');

const router = express.Router();

function upsertUser({ sub, name, picture, isFriend }) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM users WHERE line_user_id = ?').get(sub);
  const envAdmin = config.adminLineIds.includes(sub);
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, picture_url = ?, is_friend = COALESCE(?, is_friend), last_login_at = ?, role = CASE WHEN ? THEN \'admin\' ELSE role END WHERE id = ?')
      .run(name, picture, isFriend, now, envAdmin ? 1 : 0, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const info = db.prepare('INSERT INTO users(line_user_id, display_name, picture_url, role, is_friend, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sub, name, picture, envAdmin ? 'admin' : 'customer', isFriend, now, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function establish(req, res, user) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    audit({ user, ip: req.ip }, 'login', 'user', user.id);
    if (user.role === 'admin') return res.redirect(returnTo && returnTo.startsWith('/admin') ? returnTo : '/admin');
    return res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  res.render('shop/login', { title: 'เข้าสู่ระบบ', error: req.query.error || null });
});

router.get('/auth/line', (req, res) => {
  if (!config.lineLoginConfigured) {
    return res.status(503).render('error', { title: 'ยังไม่ได้ตั้งค่า LINE Login', status: 503,
      message: 'ผู้ดูแลระบบยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID และ LINE_LOGIN_CHANNEL_SECRET ในไฟล์ .env — ดูขั้นตอนใน README' });
  }
  res.redirect(line.buildAuthorizeUrl(req.session));
});

router.get('/auth/line/callback', async (req, res) => {
  try {
    const profile = await line.handleCallback(req.session, req.query);
    establish(req, res, upsertUser(profile));
  } catch (e) {
    console.error('[auth] LINE login failed:', e.message);
    res.redirect(`/login?error=${encodeURIComponent(e.message)}`);
  }
});

// Development-only login (clearly labelled; disabled when NODE_ENV=production)
router.post('/auth/dev-login', (req, res) => {
  if (!config.devLogin) return res.status(404).end();
  const name = String(req.body.name || '').trim().slice(0, 40) || 'Dev User';
  const role = req.body.role === 'admin' ? 'admin' : 'customer';
  const sub = `dev-${role}-${name.toLowerCase().replace(/[^a-z0-9ก-๙]+/g, '-')}`;
  let user = upsertUser({ sub, name, picture: null, isFriend: null });
  if (role === 'admin' && user.role !== 'admin') {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  establish(req, res, user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
module.exports.upsertUser = upsertUser;
