'use strict';
const express = require('express');
const { db, getSettings, settingNum } = require('../db');
const A = require('../lib/availability');
const O = require('../lib/orders');
const T = require('../lib/time');
const L = require('../lib/labels');
const { unitPrice, priceDetail, tiers } = require('../lib/pricing');
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

/**
 * Card data for the catalog. Every product is listed; status is
 *   available   — bookable for the chosen window (or, with no dates, at the earliest allowed start)
 *   unavailable — busy; `nextAt` = estimated earliest start when it can be booked again
 *   out         — no stock at all
 */
function productCardData(p, rental, qtyNeeded = 1, onlySkuIds = null) {
  const allSkus = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id);
  const skus = onlySkuIds ? allSkus.filter((s) => onlySkuIds.has(s.id)) : allSkus;
  const images = db.prepare('SELECT filename FROM product_images WHERE product_id = ? ORDER BY sort, id LIMIT 8').all(p.id).map((r) => r.filename);
  const totalStock = skus.reduce((a, s) => a + s.stock_qty, 0);
  let sizes = allSkus.map((s) => ({ id: s.id, label: s.size_label, stock: s.stock_qty, available: null }));
  const variants = allSkus.map((s) => ({ size: s.size_label, sku: s }));
  let availability = 'out'; let nextAt = null;
  if (totalStock > 0) {
    const days = rental.days || A.durationOptions()[0] || 1;
    const from = rental.startAt || Date.now();
    if (rental.startAt) {
      const w = A.windowFor(p, rental.startAt, rental.days);
      sizes = sizes.map((s) => ({ ...s, available: A.availableQty(s.id, w.blockStart, w.blockEnd) }));
    }
    const next = A.nextAvailable(p, skus, from, days, qtyNeeded);
    const earliest = A.roundToOpen(Math.max(from, Date.now() + settingNum('min_advance_hours', 0) * T.HOUR));
    if (next && next.startAt <= earliest) availability = 'available';
    else {
      // busy only because of bookings the admin hasn't confirmed yet → "awaiting confirmation" (still locked)
      const w = A.windowFor(p, earliest, days);
      const freeIgnoringHolds = skus.some((sk) => sk.stock_qty >= qtyNeeded && A.availableQty(sk.id, w.blockStart, w.blockEnd, { sku: sk, confirmedOnly: true }) >= qtyNeeded);
      availability = freeIgnoringHolds ? 'held' : 'unavailable';
      nextAt = next ? next.startAt : null;
    }
    if (!rental.startAt) sizes = sizes.map((s) => ({ ...s, available: null }));
  }
  // การ์ดในคอลเลกชันแสดงราคาเช่า 1 วันเสมอ (ถ้าสินค้าไม่มีแพ็กเกจ 1 วัน ใช้แพ็กเกจที่สั้นที่สุด)
  const cardDays = tiers(p)[0].days;
  const pd = priceDetail(p, cardDays);
  return { ...p, image: images[0] || null, images, sizes, variants, totalStock, availability, nextAt, price: pd.price, originalPrice: pd.original, promo: pd.promo, percentOff: pd.percentOff, priceDays: cardDays };
}

const { MEASURES, SIZES } = L;
/** Read ?bmin=&bmax=… ranges from the query (swapped if entered backwards). */
function readMeasureFilter(q) {
  const num = (v) => { const n = Number(String(v ?? '').trim().replace(',', '.')); return String(v ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
  const fields = MEASURES.map((m) => {
    let min = num(q[`${m.key}min`]); let max = num(q[`${m.key}max`]);
    if (min != null && max != null && min > max) [min, max] = [max, min];
    const free = q[`${m.key}fs`] === '1';          // ลูกค้าเลือก Freesize สำหรับสัดส่วนนี้ → ไม่ใช้ช่วงตัวเลข
    if (free) { min = null; max = null; }
    return { ...m, min, max, free };
  });
  const size = SIZES.includes(q.size) ? q.size : null;
  return { fields, size, active: fields.filter((f) => f.free || f.min != null || f.max != null) };
}

function availabilityNote() {
  const st = getSettings();
  const fmt = (h) => (h % 24 === 0 ? `${h / 24} วัน` : `${h} ชม.`);
  const after = Number(st.buffer_after_hours) || 0; const extra = Number(st.parcel_extra_hours) || 0; const before = Number(st.buffer_before_hours) || 0;
  return { express: fmt(after), parcel: fmt(after + extra), before: before ? fmt(before) : null,
    exampleDue: '10 พ.ย. 09:00 น.', exampleExpress: T.dt(T.parseLocal('2026-11-10', '09:00') + (after + before) * T.HOUR), exampleParcel: T.dt(T.parseLocal('2026-11-10', '09:00') + (after + extra + before) * T.HOUR) };
}

router.get('/', (req, res) => {
  const rental = rentalFromReq(req);
  const q = req.query;
  const where = ['p.is_active = 1', 'p.deleted_at IS NULL'];
  const params = {};
  if (q.q) { where.push('(p.name LIKE @q OR p.description LIKE @q)'); params.q = `%${q.q}%`; }
  // สัดส่วน B / W / H / L (นิ้ว): ลูกค้าใส่ช่วง "ตั้งแต่ … ถึง …" — ชุดที่ค่าอยู่ในช่วงเท่านั้นที่แสดง
  const measure = readMeasureFilter(q);
  //   • Freesize → เฉพาะชุดที่สัดส่วนนั้นเป็น Freesize
  //   • ช่วงตัวเลข → ชุดที่สัดส่วน (ค่าเดียวหรือช่วง) ซ้อนทับกับช่วงที่ลูกค้าใส่ + ชุดที่สัดส่วนนั้นเป็น Freesize
  // ชุดที่มีหลายไซส์: ต้องมี "ไซส์ใดไซส์หนึ่ง" ที่ตรงทุกเงื่อนไขพร้อมกัน
  const skuWhere = [];
  for (const m of measure.active) {
    if (m.free) { skuWhere.push(`s.${m.col}_free = 1`); continue; }
    const cond = [];
    if (m.min != null) { cond.push(`COALESCE(s.${m.col}_max, s.${m.col}) >= @${m.key}min`); params[`${m.key}min`] = m.min; }
    if (m.max != null) { cond.push(`s.${m.col} <= @${m.key}max`); params[`${m.key}max`] = m.max; }
    skuWhere.push(`(s.${m.col}_free = 1 OR (${cond.join(' AND ')}))`);
  }
  if (measure.size) { skuWhere.push('s.size_label = @size'); params.size = measure.size; }
  if (skuWhere.length) where.push(`EXISTS (SELECT 1 FROM skus s WHERE s.product_id = p.id AND s.deleted_at IS NULL AND ${skuWhere.join(' AND ')})`);
  const sort = { price_asc: 'p.base_price ASC', price_desc: 'p.base_price DESC', popular: 'pop DESC' }[q.sort] || 'p.created_at DESC';
  const skuMatch = skuWhere.length ? db.prepare(`SELECT s.id FROM skus s WHERE s.product_id = ? AND s.deleted_at IS NULL AND ${skuWhere.join(' AND ')}`) : null;
  const skuParams = Object.fromEntries(Object.entries(params).filter(([k]) => skuWhere.join(' ').includes('@' + k)));
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status IN ('confirmed','returned','completed')) AS pop
    FROM products p WHERE ${where.join(' AND ')} ORDER BY ${sort}`).all(params);

  const qtyNeeded = 1;
  let rentalError = null;
  if (rental.startAt && rental.days) rentalError = A.validateRentalRequest(rental.startAt, rental.days);
  else if (rental.date && !rental.startAt) rentalError = 'วันที่ไม่ถูกต้อง';
  const validRental = rental.startAt && rental.days && !rentalError ? rental : { startAt: null, days: null };
  // availability badge counts only the sizes that match the filter
  let products = rows.map((p) => productCardData(p, validRental, qtyNeeded, skuMatch ? new Set(skuMatch.all(skuParams, p.id).map((r) => r.id)) : null));
  // all dresses are listed by default; bookable ones first (stable within each group)
  const rank = { available: 0, held: 1, unavailable: 2, out: 3 };
  products = products.map((p, i) => ({ p, i })).sort((a, b) => rank[a.p.availability] - rank[b.p.availability] || a.i - b.i).map((x) => x.p);
  const onlyAvailable = q.show === 'available';
  if (onlyAvailable) products = products.filter((p) => p.availability === 'available');

  const due = validRental.startAt ? A.windowFor(null, validRental.startAt, validRental.days) : null;
  res.render('shop/home', {
    title: null, products, measure, sizes: SIZES, rental, rentalError, due, timeOptions: timeOptions(),
    durations: A.durationOptions(), qtyNeeded, onlyAvailable, totalBeforeFilter: rows.length, note: availabilityNote(),
  });
});

router.get('/products/:id', (req, res, next) => {
  const p = db.prepare('SELECT p.* FROM products p WHERE p.id = ? AND p.deleted_at IS NULL').get(req.params.id);
  if (!p || (!p.is_active && !(req.user && req.user.role === 'admin'))) return next();
  const rental = rentalFromReq(req);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(p.id);
  const skus = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id);
  const sizeChart = parseSizeChart(p.size_chart);
  const buffers = A.productBuffers(p);
  const defaultTime = rental.time || `${T.pad(Number(getSettings().pickup_start_hour))}:00`;
  // แสดงเฉพาะแพ็กเกจราคาที่แอดมินตั้งไว้ (เช่น 1 / 3 / 5 วัน) ไม่แสดงวันที่คำนวณต่อเอง
  const priceRows = tiers(p).map((t) => ({ days: t.days, ...priceDetail(p, t.days) }));
  res.render('shop/product', {
    title: p.name, p, images, skus, sizeChart, buffers, rental, defaultTime, priceRows, firstPrice: priceDetail(p, (rental.days || tiers(p)[0].days)), timeOptions: timeOptions(), durations: A.durationOptions(),
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
  const qty = Math.max(1, parseInt(req.query.qty, 10) || 1);
  let nextLabel = null; let held = false;
  if (available < qty) {
    held = A.availableQty(sku.id, w.blockStart, w.blockEnd, { confirmedOnly: true }) >= qty;
    const n = held ? null : A.nextAvailable(sku, [sku], startAt, days, qty);
    nextLabel = n ? T.dt(n.startAt) : null;
  }
  const pd = priceDetail(sku, days);
  res.json({ ok: true, available, nextLabel, held, startLabel: T.dt(w.startAt), dueLabel: T.dt(w.dueAt), hours: w.hours, unitPrice: pd.price, listPrice: pd.original, promoLabel: pd.promo ? (pd.promo.label || 'โปรโมชั่น') : null });
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
  if (avail < qty) throw new O.BookingError(avail <= 0 ? `${sku.name}${sku.size_label ? ' ไซส์ ' + sku.size_label : ''} ไม่ว่างในช่วงเวลานี้ (รวมรายการในตะกร้าแล้ว)` : `${sku.name}${sku.size_label ? ' ไซส์ ' + sku.size_label : ''} ว่างเพียง ${avail} ชิ้นในช่วงเวลานี้ (รวมรายการในตะกร้าแล้ว)`);
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
