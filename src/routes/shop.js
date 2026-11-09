'use strict';
const express = require('express');
const { db, getSettings, settingNum } = require('../db');
const A = require('../lib/availability');
const O = require('../lib/orders');
const T = require('../lib/time');
const L = require('../lib/labels');
const { unitPrice } = require('../lib/pricing');
const { requireLogin } = require('../middleware/auth');
const addr = require('../lib/thai-address');

const router = express.Router();

function timeOptions() {
  const s = getSettings();
  const out = [];
  for (let h = Number(s.pickup_start_hour); h <= Number(s.pickup_end_hour); h++) {
    out.push(`${T.pad(h)}:00`);
    if (h < Number(s.pickup_end_hour)) out.push(`${T.pad(h)}:30`);
  }
  return out;
}

/** Read the rental window from query (or remember it in session). */
function rentalFromReq(req) {
  const q = req.query;
  if (q.start_date !== undefined) {
    req.session.rental = { date: q.start_date || '', time: q.start_time || '', days: q.days || '' };
  }
  const r = req.session.rental || {};
  const days = parseInt(r.days, 10) || null;
  const startAt = r.date ? T.parseLocal(r.date, r.time || `${T.pad(Number(getSettings().pickup_start_hour))}:00`) : null;
  return { date: r.date || '', time: r.time || '', days, startAt };
}

function productCardData(p, rental, qtyNeeded = 1) {
  const skus = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id);
  const image = db.prepare('SELECT filename FROM product_images WHERE product_id = ? ORDER BY sort, id LIMIT 1').get(p.id);
  const totalStock = skus.reduce((a, s) => a + s.stock_qty, 0);
  let sizes = skus.map((s) => ({ id: s.id, label: s.size_label, stock: s.stock_qty, available: null }));
  let availability = totalStock > 0 ? 'in_stock' : 'out';
  if (rental.startAt && rental.days) {
    const w = A.windowFor(p, rental.startAt, rental.days);
    sizes = sizes.map((s) => ({ ...s, available: A.availableQty(s.id, w.blockStart, w.blockEnd) }));
    availability = sizes.some((s) => s.available >= qtyNeeded) ? 'available' : 'unavailable';
  }
  return { ...p, image: image && image.filename, sizes, totalStock, availability, price: unitPrice(p, rental.days || p.base_days) };
}

router.get('/', (req, res) => {
  const rental = rentalFromReq(req);
  const q = req.query;
  const where = ['p.is_active = 1', 'p.deleted_at IS NULL'];
  const params = {};
  if (q.q) { where.push('(p.name LIKE @q OR c.name LIKE @q OR p.description LIKE @q)'); params.q = `%${q.q}%`; }
  if (q.category) { where.push('p.category_id = @cat'); params.cat = Number(q.category); }
  if (q.size) { where.push('EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.deleted_at IS NULL AND s.size_label = @size)'); params.size = q.size; }
  if (q.min) { where.push('p.base_price >= @min'); params.min = Number(q.min); }
  if (q.max) { where.push('p.base_price <= @max'); params.max = Number(q.max); }
  const sort = { price_asc: 'p.base_price ASC', price_desc: 'p.base_price DESC', popular: 'pop DESC' }[q.sort] || 'p.created_at DESC';
  const rows = db.prepare(`SELECT p.*, c.name AS category_name,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status IN ('confirmed','returned','completed')) AS pop
    FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(' AND ')} ORDER BY ${sort}`).all(params);

  const qtyNeeded = Math.max(1, parseInt(q.qty, 10) || 1);
  let rentalError = null;
  if (rental.startAt && rental.days) rentalError = A.validateRentalRequest(rental.startAt, rental.days);
  else if (rental.date && !rental.startAt) rentalError = 'วันที่ไม่ถูกต้อง';
  const validRental = rental.startAt && rental.days && !rentalError ? rental : { startAt: null, days: null };
  let products = rows.map((p) => productCardData(p, validRental, qtyNeeded));
  if (q.size && validRental.startAt) products = products.filter((p) => p.sizes.some((s) => s.label === q.size && s.available >= qtyNeeded));
  const onlyAvailable = validRental.startAt && q.show !== 'all';
  if (onlyAvailable) products = products.filter((p) => p.availability === 'available');

  const categories = db.prepare('SELECT * FROM categories ORDER BY sort, name').all();
  const sizes = db.prepare("SELECT DISTINCT size_label FROM skus s JOIN products p ON p.id = s.product_id WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.is_active = 1 ORDER BY size_label").all().map((r) => r.size_label);
  const due = validRental.startAt ? A.windowFor(null, validRental.startAt, validRental.days) : null;
  res.render('shop/home', {
    title: 'เช่าชุด', products, categories, sizes, rental, rentalError, due, timeOptions: timeOptions(),
    durations: A.durationOptions(), qtyNeeded, onlyAvailable, totalBeforeFilter: rows.length,
  });
});

router.get('/products/:id', (req, res, next) => {
  const p = db.prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.deleted_at IS NULL').get(req.params.id);
  if (!p || (!p.is_active && !(req.user && req.user.role === 'admin'))) return next();
  const rental = rentalFromReq(req);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(p.id);
  const skus = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id);
  const sizeChart = parseSizeChart(p.size_chart);
  const buffers = A.productBuffers(p);
  const defaultTime = rental.time || `${T.pad(Number(getSettings().pickup_start_hour))}:00`;
  res.render('shop/product', {
    title: p.name, p, images, skus, sizeChart, buffers, rental, defaultTime, timeOptions: timeOptions(), durations: A.durationOptions(),
    minDate: T.toInputDate(Date.now() + settingNum('min_advance_hours', 0) * T.HOUR),
  });
});

function parseSizeChart(text) {
  const rows = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s*[,|\t]\s*/));
  return rows.length >= 2 ? { head: rows[0], rows: rows.slice(1) } : null;
}

/** Live availability for one SKU and rental window. */
router.get('/api/availability', (req, res) => {
  const sku = db.prepare('SELECT s.*, p.base_price, p.base_days, p.extra_day_price, p.buffer_before_hours, p.buffer_after_hours FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ? AND s.deleted_at IS NULL').get(req.query.sku);
  if (!sku) return res.status(404).json({ error: 'not_found' });
  const days = parseInt(req.query.days, 10);
  const startAt = T.parseLocal(req.query.date, req.query.time);
  const err = A.validateRentalRequest(startAt, days);
  if (err) return res.json({ ok: false, error: err });
  const w = A.windowFor(sku, startAt, days);
  const available = A.availableQty(sku.id, w.blockStart, w.blockEnd);
  res.json({ ok: true, available, startLabel: T.dt(w.startAt), dueLabel: T.dt(w.dueAt), hours: w.hours, unitPrice: unitPrice(sku, days) });
});

/** Month calendar: for each day, how many units are free if the rental starts that day at `time` for `days`. */
router.get('/api/calendar', (req, res) => {
  const sku = db.prepare('SELECT s.*, p.buffer_before_hours, p.buffer_after_hours FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ? AND s.deleted_at IS NULL').get(req.query.sku);
  if (!sku) return res.status(404).json({ error: 'not_found' });
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || '') || [null, ...T.toInputDate(Date.now()).split('-')];
  const y = Number(m[1]); const mo = Number(m[2]);
  const days = parseInt(req.query.days, 10) || A.durationOptions()[0];
  const time = /^\d{2}:\d{2}$/.test(req.query.time || '') ? req.query.time : `${T.pad(Number(getSettings().pickup_start_hour))}:00`;
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= n; d++) {
    const date = `${y}-${T.pad(mo)}-${T.pad(d)}`;
    const startAt = T.parseLocal(date, time);
    const err = A.validateRentalRequest(startAt, days);
    if (err) { out.push({ date, state: 'closed', available: 0 }); continue; }
    const w = A.windowFor(sku, startAt, days);
    const a = A.availableQty(sku.id, w.blockStart, w.blockEnd);
    out.push({ date, state: a > 0 ? 'free' : 'full', available: a });
  }
  res.json({ month: `${y}-${T.pad(mo)}`, days, time, stock: sku.stock_qty, dates: out });
});

// ---------------- Cart ----------------
router.get('/cart', requireLogin, (req, res) => {
  const cart = O.evaluateCart(req.user.id);
  res.render('shop/cart', { title: 'ตะกร้าสินค้า', cart, durations: A.durationOptions(), timeOptions: timeOptions() });
});

function parseCartInput(body) {
  const qty = parseInt(body.qty, 10);
  const days = parseInt(body.days, 10);
  const startAt = T.parseLocal(body.start_date, body.start_time);
  if (!(qty > 0) || qty > 50) throw new O.BookingError('จำนวนไม่ถูกต้อง');
  const err = A.validateRentalRequest(startAt, days);
  if (err) throw new O.BookingError(err);
  return { qty, days, startAt };
}

function checkCartLine(userId, skuId, { qty, days, startAt }, ignoreCartId = 0) {
  const sku = db.prepare('SELECT s.*, p.name, p.is_active, p.deleted_at AS pdel, p.buffer_before_hours, p.buffer_after_hours FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ?').get(skuId);
  if (!sku || sku.deleted_at || sku.pdel || !sku.is_active) throw new O.BookingError('ไม่พบสินค้าหรือสินค้าปิดการให้เช่า');
  const w = A.windowFor(sku, startAt, days);
  let avail = A.availableQty(sku.id, w.blockStart, w.blockEnd, { sku });
  const others = db.prepare('SELECT * FROM cart_items WHERE user_id = ? AND sku_id = ? AND id != ?').all(userId, skuId, ignoreCartId);
  for (const c of others) {
    const ow = A.windowFor(sku, c.start_at, c.days);
    if (ow.blockStart < w.blockEnd && ow.blockEnd > w.blockStart) avail -= c.qty;
  }
  if (avail < qty) throw new O.BookingError(avail <= 0 ? `${sku.name} ไซส์ ${sku.size_label} ไม่ว่างในช่วงเวลานี้ (รวมรายการในตะกร้าแล้ว)` : `${sku.name} ไซส์ ${sku.size_label} ว่างเพียง ${avail} ชิ้นในช่วงเวลานี้ (รวมรายการในตะกร้าแล้ว)`);
  return sku;
}

router.post('/cart/add', requireLogin, (req, res) => {
  const input = parseCartInput(req.body);
  const skuId = parseInt(req.body.sku_id, 10);
  checkCartLine(req.user.id, skuId, input);
  const same = db.prepare('SELECT * FROM cart_items WHERE user_id = ? AND sku_id = ? AND start_at = ? AND days = ?').get(req.user.id, skuId, input.startAt, input.days);
  if (same) {
    checkCartLine(req.user.id, skuId, { ...input, qty: same.qty + input.qty }, same.id);
    db.prepare('UPDATE cart_items SET qty = qty + ? WHERE id = ?').run(input.qty, same.id);
  } else {
    db.prepare('INSERT INTO cart_items(user_id, sku_id, qty, start_at, days, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.user.id, skuId, input.qty, input.startAt, input.days, Date.now());
  }
  req.session.rental = { date: req.body.start_date, time: req.body.start_time, days: String(input.days) };
  res.flash('success', 'เพิ่มสินค้าลงตะกร้าแล้ว');
  res.redirect(req.body.next === 'product' ? `/products/${req.body.product_id}` : '/cart');
});

router.post('/cart/:id/update', requireLogin, (req, res) => {
  const line = db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!line) return res.redirect('/cart');
  const input = parseCartInput(req.body);
  checkCartLine(req.user.id, line.sku_id, input, line.id);
  db.prepare('UPDATE cart_items SET qty = ?, start_at = ?, days = ? WHERE id = ?').run(input.qty, input.startAt, input.days, line.id);
  res.flash('success', 'อัปเดตตะกร้าแล้ว');
  res.redirect('/cart');
});

router.post('/cart/:id/remove', requireLogin, (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.flash('success', 'ลบสินค้าออกจากตะกร้าแล้ว');
  res.redirect('/cart');
});

// ---------------- Checkout ----------------
router.get('/checkout', requireLogin, (req, res) => {
  const cart = O.evaluateCart(req.user.id);
  if (!cart.lines.length) return res.redirect('/cart');
  if (!cart.ok) { res.flash('error', 'มีสินค้าในตะกร้าที่ไม่สามารถจองได้ กรุณาแก้ไขก่อนดำเนินการต่อ'); return res.redirect('/cart'); }
  const last = db.prepare('SELECT recipient_name, phone, address, province, district, subdistrict, postcode, shipping_method FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
  const form = req.session.checkoutForm || last || {};
  res.render('shop/checkout', { title: 'ข้อมูลการจัดส่ง', cart, form, errors: {}, provinces: L.PROVINCES, addrOpts: addr.options(form), emsFee: settingNum('ems_fee', 0) });
});

function validateShipping(b) {
  const f = {
    recipient_name: String(b.recipient_name || '').trim(), phone: String(b.phone || '').replace(/[^\d]/g, ''),
    address: String(b.address || '').trim(), province: String(b.province || '').trim(), district: String(b.district || '').trim(),
    subdistrict: String(b.subdistrict || '').trim(), postcode: String(b.postcode || '').trim(), shipping_method: b.shipping_method,
    customer_note: String(b.customer_note || '').trim().slice(0, 500),
  };
  const e = {};
  if (f.recipient_name.length < 2) e.recipient_name = 'กรุณากรอกชื่อ-นามสกุล';
  if (!/^0\d{8,9}$/.test(f.phone)) e.phone = 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678)';
  if (f.address.length < 5) e.address = 'กรุณากรอกที่อยู่ (บ้านเลขที่ ถนน ซอย)';
  Object.assign(e, addr.validate(f));
  if (!['ems', 'express'].includes(f.shipping_method)) e.shipping_method = 'กรุณาเลือกวิธีจัดส่ง';
  for (const k of ['recipient_name', 'address', 'district', 'subdistrict']) f[k] = f[k].slice(0, 300);
  return { f, e };
}

router.post('/checkout', requireLogin, (req, res) => {
  const { f, e } = validateShipping(req.body);
  if (Object.keys(e).length) {
    const cart = O.evaluateCart(req.user.id);
    return res.status(422).render('shop/checkout', { title: 'ข้อมูลการจัดส่ง', cart, form: f, errors: e, provinces: L.PROVINCES, addrOpts: addr.options(f), emsFee: settingNum('ems_fee', 0) });
  }
  req.session.checkoutForm = f;
  try {
    const order = O.createOrderFromCart(req.user, f);
    delete req.session.checkoutForm;
    if (!req.user.phone) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(f.phone, req.user.id);
    res.redirect(`/orders/${order.code}/pay`);
  } catch (err) {
    if (!err.isBookingError) throw err;
    res.flash('error', `${err.message}${err.details ? ` — ${err.details.join(' · ')}` : ''}`);
    res.redirect('/cart');
  }
});

module.exports = router;
