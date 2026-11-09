'use strict';
const crypto = require('crypto');
const { db } = require('../db');

const qUser = db.prepare('SELECT * FROM users WHERE id = ?');

/** Load the user fresh from DB on every request — role changes take effect immediately. */
function loadUser(req, res, next) {
  req.user = req.session.userId ? qUser.get(req.session.userId) || null : null;
  if (req.session.userId && !req.user) delete req.session.userId;
  res.locals.user = req.user;
  res.locals.isAdmin = !!(req.user && req.user.role === 'admin');
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.status(401).json({ error: 'login_required' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.user) { req.session.returnTo = req.originalUrl; return res.redirect('/login'); }
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'ไม่มีสิทธิ์เข้าถึง', message: 'หน้านี้สำหรับผู้ดูแลระบบเท่านั้น', status: 403 });
  next();
}

/** Synchronizer-token CSRF protection for all state-changing requests. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || (req.query && req.query._csrf);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(req.session.csrf);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(403).render('error', { title: 'คำขอไม่ถูกต้อง', message: 'เซสชันหมดอายุหรือคำขอไม่ถูกต้อง กรุณารีเฟรชหน้าแล้วลองอีกครั้ง', status: 403 });
}

module.exports = { loadUser, requireLogin, requireAdmin, csrf };
