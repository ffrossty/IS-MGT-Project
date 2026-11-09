'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const { getSettings } = require('./db');
const SqliteStore = require('./lib/session-store');
const { loadUser, csrf } = require('./middleware/auth');
const T = require('./lib/time');
const L = require('./lib/labels');
const { baht } = require('./lib/pricing');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
if (config.isProd) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'https://profile.line-scdn.net', 'https://*.line-scdn.net'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'script-src': ["'self'"],
      'form-action': ["'self'", 'https://access.line.me'],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use('/static/data', express.static(path.join(__dirname, '..', 'public', 'data'), { maxAge: '7d' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
// Product & shop images are public; payment slips are NOT (served via an auth-checked route).
app.use('/media/products', express.static(path.join(config.uploadDir, 'products'), { maxAge: '30d', fallthrough: false }));
app.use('/media/settings', express.static(path.join(config.uploadDir, 'settings'), { maxAge: '1d', fallthrough: false }));

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new SqliteStore(),
  name: 'rental.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(loadUser);

app.use((req, res, next) => {
  const s = getSettings();
  Object.assign(res.locals, {
    settings: s, T, L, baht, h: require('./lib/view-helpers'),
    cartCount: req.user ? require('./db').db.prepare('SELECT COUNT(*) n FROM cart_items WHERE user_id = ?').get(req.user.id).n : 0,
    config: { devLogin: config.devLogin, lineLoginConfigured: config.lineLoginConfigured, oaBasicId: config.line.oaBasicId, baseUrl: config.baseUrl },
    path: req.path, flash: req.session.flash || null, query: req.query,
  });
  delete req.session.flash;
  res.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});
app.use(csrf);

app.use(require('./routes/auth'));
app.use(require('./routes/shop'));
app.use(require('./routes/account'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'ไม่พบหน้าที่ต้องการ', message: 'ลิงก์อาจไม่ถูกต้องหรือหน้านี้ถูกลบไปแล้ว', status: 404 }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isUser = err.isBookingError || err.name === 'MulterError' || /รองรับเฉพาะ/.test(err.message);
  if (!isUser) console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์มีขนาดใหญ่เกินไป' : isUser ? err.message : 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง';
  if (isUser && req.method === 'POST' && req.get('referer')) {
    req.session.flash = { type: 'error', msg: msg + (err.details ? ` — ${err.details.join(' · ')}` : '') };
    return res.redirect(req.get('referer'));
  }
  res.status(isUser ? 400 : 500).render('error', { title: 'เกิดข้อผิดพลาด', message: msg, status: isUser ? 400 : 500 });
});

if (require.main === module) {
  require('./lib/jobs').start();
  app.listen(config.port, () => {
    console.log(`\n  ✦ ${getSettings().shop_name} running at ${config.baseUrl}  (port ${config.port}, ${config.env})`);
    console.log(`    LINE Login: ${config.lineLoginConfigured ? 'configured' : 'NOT configured'} · LINE OA: ${config.lineMessagingConfigured ? 'configured' : 'NOT configured'} · Google Sheets: ${config.sheetsConfigured ? 'configured' : 'NOT configured'}${config.devLogin ? ' · DEV LOGIN ENABLED' : ''}\n`);
  });
}

module.exports = app;
