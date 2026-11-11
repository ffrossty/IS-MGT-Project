'use strict';
const path = require('path');
const express = require('express');
const config = require('../config');
const { db, getSettings, setSettings, DEFAULT_SETTINGS } = require('../db');
const A = require('../lib/availability');
const O = require('../lib/orders');
const T = require('../lib/time');
const L = require('../lib/labels');
const sheets = require('../lib/sheets');
const line = require('../lib/line');
const backup = require('../lib/backup');
const promptpay = require('../lib/promptpay');
const { audit } = require('../lib/audit');
const { imageUploader, verifyImages, removeFile } = require('../lib/upload');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.adminNav = {
    pending: db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pending_approval'").get().n,
  };
  res.locals.sheetUrl = getSettings().google_sheet_url || sheets.sheetUrl();
  next();
});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// ---------------------------------------------------------------- Dashboard
function rangeFromQuery(q) {
  const now = T.localParts(Date.now());
  const year = int(q.year, now.y);
  const month = q.month === 'all' ? null : int(q.month, q.year ? 0 : now.m) || null;
  if (q.from || q.to) {
    const from = T.parseLocal(q.from) || T.parseLocal(`${year}-01-01`);
    const to = (T.parseLocal(q.to) || Date.now()) + T.DAY;
    return { from, to, year, month: null, label: `${T.date(from)} – ${T.date(to - 1)}`, custom: true };
  }
  if (month) {
    const from = T.parseLocal(`${year}-${T.pad(month)}-01`);
    const to = month === 12 ? T.parseLocal(`${year + 1}-01-01`) : T.parseLocal(`${year}-${T.pad(month + 1)}-01`);
    return { from, to, year, month, label: new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: T.TZ }).format(from + T.DAY) };
  }
  return { from: T.parseLocal(`${year}-01-01`), to: T.parseLocal(`${year + 1}-01-01`), year, month: null, label: `ปี ${year + 543}` };
}

router.get('/', (req, res) => {
  const r = rangeFromQuery(req.query);
  const now = Date.now();
  const c = (sql, ...p) => db.prepare(sql).get(...p).n || 0;
  const inRange = 'created_at >= ? AND created_at < ?';
  const paid = "status IN ('confirmed','returned','completed') AND payment_status = 'approved'";
  const stats = {
    total: c(`SELECT COUNT(*) n FROM orders WHERE ${inRange} AND slip_filename IS NOT NULL`, r.from, r.to),
    awaitingPayment: c("SELECT COUNT(*) n FROM orders WHERE status = 'awaiting_payment' AND hold_expires_at > ?", now),
    pendingApproval: c("SELECT COUNT(*) n FROM orders WHERE status = 'pending_approval'"),
    slipToCheck: c("SELECT COUNT(*) n FROM orders WHERE status = 'pending_approval' AND payment_status = 'submitted'"),
    overdueReview: c("SELECT COUNT(*) n FROM orders WHERE status = 'pending_approval' AND review_overdue = 1"),
    confirmed: c(`SELECT COUNT(*) n FROM orders WHERE ${inRange} AND status = 'confirmed'`, r.from, r.to),
    completed: c(`SELECT COUNT(*) n FROM orders WHERE ${inRange} AND status = 'completed'`, r.from, r.to),
    renting: c("SELECT COALESCE(SUM(oi.qty),0) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'confirmed' AND oi.start_at <= ? AND oi.due_at > ?", now, now),
    awaitingReturn: c("SELECT COALESCE(SUM(oi.qty),0) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status = 'confirmed' AND oi.start_at <= ? AND oi.due_at <= ?", now, now + T.DAY),
    revenue: c(`SELECT COALESCE(SUM(total),0) n FROM orders WHERE ${inRange} AND ${paid}`, r.from, r.to),
  };
  // revenue series: by day for ≤ 62-day ranges, otherwise by month
  const byDay = r.to - r.from <= 62 * T.DAY;
  const rows = db.prepare(`SELECT created_at, total FROM orders WHERE ${inRange} AND ${paid}`).all(r.from, r.to);
  const buckets = new Map();
  for (let t = r.from; t < r.to;) {
    const p = T.localParts(t);
    const key = byDay ? T.toInputDate(t) : `${p.y}-${T.pad(p.m)}`;
    buckets.set(key, 0);
    t = byDay ? t + T.DAY : T.parseLocal(p.m === 12 ? `${p.y + 1}-01-01` : `${p.y}-${T.pad(p.m + 1)}-01`);
  }
  for (const o of rows) {
    const p = T.localParts(o.created_at);
    const key = byDay ? T.toInputDate(o.created_at) : `${p.y}-${T.pad(p.m)}`;
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + o.total);
  }
  const series = [...buckets].map(([k, v]) => ({ key: k, label: byDay ? String(Number(k.slice(8))) : new Intl.DateTimeFormat('th-TH', { month: 'short', timeZone: T.TZ }).format(T.parseLocal(`${k}-15`)), value: v }));
  const popular = db.prepare(`SELECT oi.product_id, oi.product_name, SUM(oi.qty) qty, SUM(oi.line_total) revenue FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.created_at < ? AND o.status IN ('confirmed','returned','completed')
    GROUP BY oi.product_id ORDER BY qty DESC, revenue DESC LIMIT 6`).all(r.from, r.to);
  const attention = db.prepare(`SELECT o.*, u.display_name FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.status = 'pending_approval' ORDER BY o.review_overdue DESC, o.slip_uploaded_at ASC LIMIT 8`).all();
  const returns = db.prepare(`SELECT oi.*, o.code, o.recipient_name, o.phone FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'confirmed' AND oi.start_at <= ? AND oi.due_at <= ? ORDER BY oi.due_at LIMIT 10`).all(now, now + 2 * T.DAY);
  const upcoming = db.prepare(`SELECT oi.*, o.code, o.recipient_name, o.shipping_status FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'confirmed' AND oi.start_at > ? AND oi.start_at <= ? ORDER BY oi.start_at LIMIT 10`).all(now, now + 3 * T.DAY);
  res.render('admin/dashboard', { title: 'Dashboard', r, stats, series, popular, attention, returns, upcoming, byDay });
});

// ---------------------------------------------------------------- Booking calendar
router.get('/calendar', (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || '') || [null, ...T.toInputDate(Date.now()).split('-')];
  const y = Number(m[1]); const mo = Number(m[2]);
  const from = T.parseLocal(`${y}-${T.pad(mo)}-01`);
  const to = mo === 12 ? T.parseLocal(`${y + 1}-01-01`) : T.parseLocal(`${y}-${T.pad(mo + 1)}-01`);
  const productId = int(req.query.product, 0);
  const items = db.prepare(`SELECT oi.*, o.code, o.status, o.recipient_name FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.block_start < ? AND oi.block_end > ? AND (o.status IN ('pending_approval','confirmed','returned','completed') OR (o.status='awaiting_payment' AND o.hold_expires_at > ?))
    ${productId ? 'AND oi.product_id = ?' : ''} ORDER BY oi.start_at`).all(...[to, from, Date.now(), ...(productId ? [productId] : [])]);
  const blocks = db.prepare(`SELECT b.*, s.size_label, p.name AS product_name FROM sku_blocks b JOIN skus s ON s.id = b.sku_id JOIN products p ON p.id = s.product_id
    WHERE b.start_at < ? AND b.end_at > ? ${productId ? 'AND p.id = ?' : ''}`).all(...[to, from, ...(productId ? [productId] : [])]);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= n; d++) {
    const ds = T.parseLocal(`${y}-${T.pad(mo)}-${T.pad(d)}`); const de = ds + T.DAY;
    days.push({
      d, ds, dow: T.localParts(ds).dow,
      starts: items.filter((i) => i.start_at >= ds && i.start_at < de),
      dues: items.filter((i) => i.due_at >= ds && i.due_at < de),
      active: items.filter((i) => i.start_at < de && i.due_at > ds).reduce((a, i) => a + i.qty, 0),
      blocks: blocks.filter((b) => b.start_at < de && b.end_at > ds),
    });
  }
  const products = db.prepare('SELECT id, name FROM products WHERE deleted_at IS NULL ORDER BY name').all();
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${T.pad(mo - 1)}`;
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${T.pad(mo + 1)}`;
  res.render('admin/calendar', { title: 'ปฏิทินการจอง', y, mo, days, products, productId, prev, next, monthLabel: new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: T.TZ }).format(from + T.DAY) });
});

// ---------------------------------------------------------------- Products
const productUpload = imageUploader('products', { maxMb: 10 });

router.get('/products', (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  const products = db.prepare(`SELECT p.*,
      (SELECT filename FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image,
      (SELECT GROUP_CONCAT(size_label || ':' || stock_qty, '  ') FROM (SELECT size_label, stock_qty FROM skus WHERE product_id = p.id AND deleted_at IS NULL ORDER BY sort, id)) AS sizes,
      (SELECT COALESCE(SUM(stock_qty),0) FROM skus WHERE product_id = p.id AND deleted_at IS NULL) AS stock
    FROM products p
    WHERE p.deleted_at IS NULL ${q ? 'AND p.name LIKE @q' : ''} ORDER BY p.created_at DESC`).all(q ? { q } : {});
  const skuStmt = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id');
  products.forEach((p) => { p.skus = skuStmt.all(p.id); });
  res.render('admin/products', { title: 'สินค้า', products });
});

function productForm(req, res, p, status = 200) {
  const images = p.id ? db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(p.id) : [];
  const skus = p.id ? db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id) : [];
  res.status(status).render('admin/product-form', { title: p.id ? `แก้ไข: ${p.name}` : 'เพิ่มสินค้าใหม่', p, images, skus, defaults: { before: getSettings().buffer_before_hours, after: getSettings().buffer_after_hours } });
}

router.get('/products/new', (req, res) => productForm(req, res, { is_active: 1, base_days: 1, price_tiers: JSON.stringify([{ days: 1, price: 350 }, { days: 3, price: 450 }, { days: 5, price: 550 }]), conditions: '' }));
router.get('/products/:id', (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!p) return next();
  productForm(req, res, p);
});

/** Measurement in inches (0.5 steps allowed); '' → null. */
function measure(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 200) throw new O.BookingError('สัดส่วนชุดต้องเป็นตัวเลข (นิ้ว) ระหว่าง 1–200');
  return Math.round(n * 10) / 10;
}

/** B/W/H/L for one size, read from form fields `${prefix}bust`, `${prefix}bust_max`, `${prefix}bust_free` … */
function readMeasures(b, prefix = '') {
  return Object.fromEntries(L.MEASURES.flatMap((m) => {
    const free = b[`${prefix}${m.col}_free`] ? 1 : 0;   // Freesize → ไม่ต้องใส่ตัวเลข
    let lo = free ? null : measure(b[`${prefix}${m.col}`]); let hi = free ? null : measure(b[`${prefix}${m.col}_max`]);
    if (lo == null && hi != null) { lo = hi; hi = null; }      // ใส่แค่ช่อง "ถึง" = ค่าเดียว
    if (lo != null && hi != null && hi < lo) [lo, hi] = [hi, lo];
    if (hi === lo) hi = null;
    return [[m.col, lo], [`${m.col}_max`, hi], [`${m.col}_free`, free]];
  }));
}
const MEASURE_COLS = L.MEASURES.flatMap((m) => [m.col, `${m.col}_max`, `${m.col}_free`]);

/**
 * Sizes of one product (each size = one SKU with its own B/W/H/L and stock).
 * Form: var_keys="0,1,n2", var_<k>_id, var_<k>_size, var_<k>_stock, var_<k>_remove, var_<k>_bust … .
 * Without var_keys (older form / API) a single size is read from size, bust…, stock_qty.
 */
function readVariants(b) {
  const keys = String(b.var_keys || '').split(',').map((k) => k.trim()).filter((k) => /^[a-z0-9]+$/i.test(k));
  if (!keys.length) {
    return { legacy: true, removed: [], variants: [{ id: null, size: L.SIZES.includes(b.size) ? b.size : '', stock_qty: Math.max(0, int(b.stock_qty, 1)), ...readMeasures(b) }] };
  }
  const variants = []; const removed = [];
  for (const k of keys) {
    const pre = `var_${k}_`;
    const id = int(b[`${pre}id`], 0) || null;
    if (b[`${pre}remove`]) { if (id) removed.push(id); continue; }
    variants.push({ id, size: L.SIZES.includes(b[`${pre}size`]) ? b[`${pre}size`] : '', stock_qty: Math.max(0, int(b[`${pre}stock`], 1)), ...readMeasures(b, pre) });
  }
  if (!variants.length) throw new O.BookingError('ต้องมีอย่างน้อย 1 ไซส์');
  if (variants.length > 1 && variants.some((v) => !v.size)) throw new O.BookingError('ชุดที่มีหลายไซส์ ต้องเลือกไซส์ให้ทุกแถว');
  const seen = new Set();
  for (const v of variants) {
    if (seen.has(v.size)) throw new O.BookingError(`มีไซส์ ${v.size || '(ไม่ระบุ)'} ซ้ำกัน — 1 ไซส์ใส่ได้แถวเดียว (เพิ่มจำนวนชุดแทน)`);
    seen.add(v.size);
  }
  return { legacy: false, removed, variants };
}

const hasOpenBookings = (skuId) => db.prepare(`SELECT COUNT(*) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.sku_id = ? AND oi.block_end > ?
  AND ${A.ACTIVE_ORDER_SQL.replace(/@now/g, '?')}`).get(skuId, Date.now(), Date.now()).n > 0;

/** Write a product's sizes (SKUs). Run inside a transaction. */
function saveVariants(req, productId, { legacy, removed, variants }) {
  const existing = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(productId);
  const byId = new Map(existing.map((s) => [s.id, s]));
  let retire = removed.filter((id) => byId.has(id));
  if (legacy) {
    // single-size form: first SKU is the size; extra old sizes retire once their bookings finish
    if (existing.length) variants[0].id = existing[0].id;
    retire = existing.slice(1).filter((s) => !hasOpenBookings(s.id)).map((s) => s.id);
  } else {
    for (const v of variants) if (v.id && !byId.has(v.id)) v.id = null;   // stale id → treat as new
    for (const id of retire) {
      if (hasOpenBookings(id)) throw new O.BookingError(`ลบไซส์ ${byId.get(id).size_label || ''} ไม่ได้ — ยังมีการจองที่ยังไม่เสร็จสิ้น (ตั้งจำนวนเป็น 0 เพื่อหยุดรับจองแทน)`);
    }
  }
  for (const id of retire) {
    db.prepare('UPDATE skus SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    db.prepare('DELETE FROM cart_items WHERE sku_id = ?').run(id);
    audit(req, 'delete', 'sku', id, byId.get(id));
  }
  // free every size label first so swapping sizes between rows can't hit the unique (product, size) index
  const kept = variants.filter((v) => v.id);
  kept.forEach((v) => db.prepare('UPDATE skus SET size_label = ? WHERE id = ?').run(`__tmp_${v.id}`, v.id));
  variants.forEach((v, i) => {
    const clash = db.prepare('SELECT id FROM skus WHERE product_id = ? AND size_label = ? AND deleted_at IS NULL AND id IS NOT ?').get(productId, v.size, v.id);
    if (clash) throw new O.BookingError(`ไซส์ ${v.size || '(ไม่ระบุ)'} เดิมยังมีการจองค้างอยู่ — ใช้ไซส์นี้กับแถวใหม่ได้หลังการจองนั้นเสร็จสิ้น`);
    const vals = { size_label: v.size, stock_qty: v.stock_qty, sort: i, ...Object.fromEntries(MEASURE_COLS.map((c) => [c, v[c]])) };
    if (v.id) {
      const before = byId.get(v.id);
      db.prepare(`UPDATE skus SET ${Object.keys(vals).map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...vals, id: v.id });
      if (before.stock_qty !== v.stock_qty || before.size_label !== v.size) audit(req, 'update_stock', 'sku', v.id, { size: before.size_label, stock: before.stock_qty }, { size: v.size, stock: v.stock_qty });
    } else {
      const cols = ['product_id', ...Object.keys(vals)];
      v.id = db.prepare(`INSERT INTO skus(${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run({ product_id: productId, ...vals }).lastInsertRowid;
      audit(req, 'create', 'sku', v.id, undefined, { size: v.size, stock: v.stock_qty });
    }
  });
  // product-level size / measurements mirror the first size (used for sorting & older screens)
  const f = variants[0];
  db.prepare(`UPDATE products SET size = @size, ${MEASURE_COLS.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
    .run({ id: productId, size: f.size || null, ...Object.fromEntries(MEASURE_COLS.map((c) => [c, f[c]])) });
}

function readProduct(b) {
  const opt = (v) => (v === '' || v == null ? null : Math.max(0, int(v)));
  // price table rows (tier_days[] / tier_price[])
  const days = [].concat(b.tier_days || []); const prices = [].concat(b.tier_price || []);
  const map = new Map();
  days.forEach((d, i) => {
    const dd = int(d, 0); const pp = String(prices[i] ?? '').trim();
    if (dd > 0 && pp !== '' && int(pp, -1) >= 0) map.set(dd, int(pp));
  });
  const tiers = [...map].map(([d, pr]) => ({ days: d, price: pr })).sort((a, c) => a.days - c.days);
  if (!tiers.length) throw new O.BookingError('กรุณาใส่ราคาเช่าอย่างน้อย 1 แถว (จำนวนวัน + ราคา)');
  const promoType = ['percent', 'amount'].includes(b.promo_type) ? b.promo_type : null;
  const promoValue = promoType ? Math.max(0, int(b.promo_value)) : null;
  if (promoType === 'percent' && promoValue > 100) throw new O.BookingError('ส่วนลดเปอร์เซ็นต์ต้องไม่เกิน 100%');
  if (promoType && !promoValue) throw new O.BookingError('กรุณาใส่มูลค่าส่วนลด');
  const promoStart = promoType && b.promo_start ? T.parseLocal(b.promo_start) : null;
  const promoEnd = promoType && b.promo_end ? T.parseLocal(b.promo_end) : null;
  if (promoStart && promoEnd && promoEnd <= promoStart) throw new O.BookingError('วันสิ้นสุดโปรโมชั่นต้องหลังวันเริ่ม');
  const p = {
    name: String(b.name || '').trim().slice(0, 150),
    description: String(b.description || '').slice(0, 5000), conditions: String(b.conditions || '').slice(0, 5000),
    price_tiers: JSON.stringify(tiers),
    base_price: tiers[0].price, base_days: tiers[0].days,  // kept in sync for sorting / price filter
    extra_day_price: Math.max(0, int(b.extra_day_price)),
    promo_type: promoType, promo_value: promoValue, promo_start: promoStart, promo_end: promoEnd,
    promo_label: promoType ? String(b.promo_label || '').trim().slice(0, 60) || null : null,
    buffer_before_hours: opt(b.buffer_before_hours), buffer_after_hours: opt(b.buffer_after_hours), is_active: b.is_active ? 1 : 0,
  };
  if (!p.name) throw new O.BookingError('กรุณากรอกชื่อสินค้า');
  return p;
}

router.post('/products', productUpload.array('images', 12), (req, res) => {
  const p = readProduct(req.body);
  const vars = readVariants(req.body);
  const now = Date.now();
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO products(name, description, conditions, base_price, base_days, extra_day_price,
      price_tiers, promo_type, promo_value, promo_start, promo_end, promo_label,
      buffer_before_hours, buffer_after_hours, is_active, created_at, updated_at) VALUES (@name, @description, @conditions,
      @base_price, @base_days, @extra_day_price, @price_tiers, @promo_type, @promo_value, @promo_start, @promo_end, @promo_label,
      @buffer_before_hours, @buffer_after_hours, @is_active, @now, @now)`).run({ ...p, now });
    const pid = info.lastInsertRowid;
    saveVariants(req, pid, vars);
    verifyImages(req.files).forEach((f, i) => db.prepare('INSERT INTO product_images(product_id, filename, sort) VALUES (?, ?, ?)').run(pid, f.filename, i));
    return pid;
  })();
  audit(req, 'create', 'product', id, undefined, p);
  res.flash('success', 'เพิ่มสินค้าเรียบร้อย');
  res.redirect(`/admin/products/${id}`);
});

router.post('/products/:id', productUpload.array('images', 12), (req, res) => {
  const before = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!before) return res.redirect('/admin/products');
  const p = readProduct(req.body);
  const vars = readVariants(req.body);
  db.transaction(() => {
    db.prepare(`UPDATE products SET name=@name, description=@description, conditions=@conditions,
      base_price=@base_price, base_days=@base_days, extra_day_price=@extra_day_price, price_tiers=@price_tiers,
      promo_type=@promo_type, promo_value=@promo_value, promo_start=@promo_start, promo_end=@promo_end, promo_label=@promo_label, buffer_before_hours=@buffer_before_hours,
      buffer_after_hours=@buffer_after_hours, is_active=@is_active, updated_at=@now WHERE id=@id`).run({ ...p, now: Date.now(), id: before.id });
    saveVariants(req, before.id, vars);
    const max = db.prepare('SELECT COALESCE(MAX(sort), -1) m FROM product_images WHERE product_id = ?').get(before.id).m;
    verifyImages(req.files).forEach((f, i) => db.prepare('INSERT INTO product_images(product_id, filename, sort) VALUES (?, ?, ?)').run(before.id, f.filename, max + 1 + i));
  })();
  audit(req, 'update', 'product', before.id, before, p);
  // warn if stock reductions now conflict with existing bookings
  const conflicts = [];
  for (const s of db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL').all(before.id)) {
    const items = db.prepare(`SELECT oi.block_start s, oi.block_end e, oi.qty q FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.sku_id = ? AND oi.block_end > ? AND ${A.ACTIVE_ORDER_SQL.replace(/@now/g, '?')}`).all(s.id, Date.now(), Date.now());
    const peak = A.maxConcurrent(items, Date.now(), 8.64e15);
    if (peak > s.stock_qty) conflicts.push(`${s.size_label || 'ชุดนี้'} (มีจองซ้อนกันสูงสุด ${peak} ชิ้น แต่สต็อก ${s.stock_qty})`);
  }
  res.flash(conflicts.length ? 'error' : 'success', conflicts.length ? `บันทึกแล้ว แต่สต็อกน้อยกว่าการจองที่มีอยู่: ${conflicts.join(', ')}` : 'บันทึกการเปลี่ยนแปลงแล้ว — หน้าร้านอัปเดตทันที');
  res.redirect(`/admin/products/${before.id}`);
});

router.post('/products/:id/toggle', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (p) { db.prepare('UPDATE products SET is_active = 1 - is_active, updated_at = ? WHERE id = ?').run(Date.now(), p.id); audit(req, p.is_active ? 'hide' : 'show', 'product', p.id); }
  res.redirect(req.get('referer') || '/admin/products');
});

router.post('/products/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/admin/products');
  const future = db.prepare(`SELECT COUNT(*) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = ? AND oi.block_end > ?
    AND ${A.ACTIVE_ORDER_SQL.replace(/@now/g, '?')}`).get(p.id, Date.now(), Date.now()).n;
  if (future) { res.flash('error', `ลบไม่ได้: ยังมีการจองที่ยังไม่เสร็จสิ้น ${future} รายการ (ปิดการแสดงสินค้าแทนได้)`); return res.redirect(`/admin/products/${p.id}`); }
  db.prepare('UPDATE products SET deleted_at = ?, is_active = 0 WHERE id = ?').run(Date.now(), p.id);
  db.prepare('DELETE FROM cart_items WHERE sku_id IN (SELECT id FROM skus WHERE product_id = ?)').run(p.id);
  audit(req, 'delete', 'product', p.id, p);
  res.flash('success', `ลบสินค้า "${p.name}" แล้ว (ประวัติคำสั่งซื้อยังคงอยู่)`);
  res.redirect('/admin/products');
});

router.post('/skus/:id/delete', (req, res) => {
  const s = db.prepare('SELECT * FROM skus WHERE id = ?').get(req.params.id);
  if (!s) return res.redirect('/admin/products');
  const future = db.prepare(`SELECT COUNT(*) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.sku_id = ? AND oi.block_end > ?
    AND ${A.ACTIVE_ORDER_SQL.replace(/@now/g, '?')}`).get(s.id, Date.now(), Date.now()).n;
  if (future) res.flash('error', `ลบไซส์ ${s.size_label} ไม่ได้: มีการจองที่ยังไม่เสร็จสิ้น ${future} รายการ`);
  else {
    db.prepare('UPDATE skus SET deleted_at = ? WHERE id = ?').run(Date.now(), s.id);
    db.prepare('DELETE FROM cart_items WHERE sku_id = ?').run(s.id);
    audit(req, 'delete', 'sku', s.id, s);
    res.flash('success', `ลบไซส์ ${s.size_label} แล้ว`);
  }
  res.redirect(`/admin/products/${s.product_id}`);
});

router.post('/images/:id/delete', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(req.params.id);
  if (img) { db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id); removeFile('products', img.filename); audit(req, 'delete', 'product_image', img.id, img); }
  res.redirect(img ? `/admin/products/${img.product_id}#images` : '/admin/products');
});

router.post('/images/:id/primary', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(req.params.id);
  if (img) {
    db.transaction(() => {
      db.prepare('UPDATE product_images SET sort = sort + 1 WHERE product_id = ?').run(img.product_id);
      db.prepare('UPDATE product_images SET sort = 0 WHERE id = ?').run(img.id);
    })();
  }
  res.redirect(img ? `/admin/products/${img.product_id}#images` : '/admin/products');
});

// Availability calendar & blocks for one product
router.get('/products/:id/calendar', (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!p) return next();
  const m = /^(\d{4})-(\d{2})$/.exec(req.query.month || '') || [null, ...T.toInputDate(Date.now()).split('-')];
  const y = Number(m[1]); const mo = Number(m[2]);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const skus = db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort, id').all(p.id);
  const grid = skus.map((s) => ({
    sku: s,
    days: Array.from({ length: n }, (_, i) => {
      const ds = T.parseLocal(`${y}-${T.pad(mo)}-${T.pad(i + 1)}`);
      return { d: i + 1, free: A.availableQty(s.id, ds, ds + T.DAY, { sku: s }), dow: T.localParts(ds).dow };
    }),
  }));
  const blocks = db.prepare(`SELECT b.*, s.size_label FROM sku_blocks b JOIN skus s ON s.id = b.sku_id WHERE s.product_id = ? AND b.end_at > ? ORDER BY b.start_at`).all(p.id, Date.now() - 30 * T.DAY);
  const bookings = db.prepare(`SELECT oi.*, o.code, o.status FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = ? AND oi.block_end > ?
    AND ${A.ACTIVE_ORDER_SQL.replace(/@now/g, '?')} ORDER BY oi.start_at`).all(p.id, Date.now(), Date.now());
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${T.pad(mo - 1)}`;
  const nextMonth = mo === 12 ? `${y + 1}-01` : `${y}-${T.pad(mo + 1)}`;
  res.render('admin/product-calendar', { title: `ปฏิทิน: ${p.name}`, p, grid, blocks, bookings, y, mo, prev, next: nextMonth, monthLabel: new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: T.TZ }).format(T.parseLocal(`${y}-${T.pad(mo)}-15`)) });
});

router.post('/products/:id/blocks', (req, res) => {
  const sku = db.prepare('SELECT * FROM skus WHERE id = ? AND product_id = ? AND deleted_at IS NULL').get(req.body.sku_id, req.params.id);
  if (!sku) throw new O.BookingError('กรุณาเลือกไซส์');
  const s = T.parseLocal(req.body.start); const e = T.parseLocal(req.body.end);
  const qty = Math.max(1, int(req.body.qty, 1));
  if (!s || !e || e <= s) throw new O.BookingError('ช่วงเวลาไม่ถูกต้อง');
  if (!L.BLOCK_REASON[req.body.reason]) throw new O.BookingError('กรุณาเลือกเหตุผล');
  const free = A.availableQty(sku.id, s, e, { sku });
  if (free < qty) throw new O.BookingError(`ช่วงเวลานี้มีชุดว่างเพียง ${free} ชิ้น (ชิ้นที่เหลือถูกจองไว้แล้ว) — ไม่สามารถปิดเกินจำนวนว่างได้`);
  const info = db.prepare('INSERT INTO sku_blocks(sku_id, qty, start_at, end_at, reason, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(sku.id, qty, s, e, req.body.reason, String(req.body.note || '').slice(0, 300), req.user.id, Date.now());
  audit(req, 'create', 'sku_block', info.lastInsertRowid, undefined, { sku: sku.id, qty, s, e, reason: req.body.reason });
  res.flash('success', 'บันทึกช่วงเวลาที่ไม่พร้อมให้เช่าแล้ว');
  res.redirect(`/admin/products/${req.params.id}/calendar?month=${T.toInputDate(s).slice(0, 7)}`);
});

router.post('/blocks/:id/delete', (req, res) => {
  const b = db.prepare('SELECT b.*, s.product_id FROM sku_blocks b JOIN skus s ON s.id = b.sku_id WHERE b.id = ?').get(req.params.id);
  if (b) { db.prepare('DELETE FROM sku_blocks WHERE id = ?').run(b.id); audit(req, 'delete', 'sku_block', b.id, b); }
  res.redirect(b ? `/admin/products/${b.product_id}/calendar` : '/admin/products');
});

// (ประเภทสินค้าเลิกใช้แล้ว)
router.get('/categories', (req, res) => res.redirect('/admin/products'));

// ---------------------------------------------------------------- Inventory
router.get('/inventory', (req, res) => {
  const from = req.query.from ? T.parseLocal(req.query.from) : null;
  const to = req.query.to ? T.parseLocal(req.query.to) : null;
  const skus = db.prepare(`SELECT s.*, p.name AS product_name, p.is_active FROM skus s JOIN products p ON p.id = s.product_id
    WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name, s.sort, s.id`).all();
  const rows = skus.map((s) => ({ ...s, st: A.skuStatusNow(s.id), rangeFree: from && to && to > from ? A.availableQty(s.id, from, to, { sku: s }) : null }));
  res.render('admin/inventory', { title: 'สต็อกสินค้า', rows, from: req.query.from || '', to: req.query.to || '' });
});

router.post('/skus/:id/stock', (req, res) => {
  const s = db.prepare('SELECT * FROM skus WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!s) return res.redirect('/admin/inventory');
  const delta = int(req.body.delta);
  const next = Math.max(0, s.stock_qty + delta);
  db.prepare('UPDATE skus SET stock_qty = ? WHERE id = ?').run(next, s.id);
  audit(req, 'adjust_stock', 'sku', s.id, { stock: s.stock_qty }, { stock: next, note: req.body.note || null });
  res.flash('success', `ปรับสต็อก ${s.size_label}: ${s.stock_qty} → ${next}`);
  res.redirect('/admin/inventory');
});

// ---------------------------------------------------------------- Orders
router.get('/orders', (req, res) => {
  const q = req.query;
  const where = ['1=1']; const p = {};
  if (q.q) { where.push('(o.code LIKE @q OR o.recipient_name LIKE @q OR o.phone LIKE @q OR o.tracking_number LIKE @q)'); p.q = `%${q.q.trim()}%`; }
  if (q.status) { where.push('o.status = @status'); p.status = q.status; }
  if (q.payment) { where.push('o.payment_status = @pay'); p.pay = q.payment; }
  if (q.from) { where.push('o.created_at >= @from'); p.from = T.parseLocal(q.from); }
  if (q.to) { where.push('o.created_at < @to'); p.to = T.parseLocal(q.to) + T.DAY; }
  if (q.rent_from) { where.push('EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.due_at >= @rf)'); p.rf = T.parseLocal(q.rent_from); }
  if (q.rent_to) { where.push('EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.start_at < @rt)'); p.rt = T.parseLocal(q.rent_to) + T.DAY; }
  // By default list only orders where the customer has attached a slip (orders abandoned at the
  // payment step would clutter the list). Searching, picking a status, or "show all" lists everything.
  const showAll = q.all === '1' || !!q.q || !!q.status;
  const hiddenCount = showAll ? 0 : db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where.join(' AND ')} AND o.slip_filename IS NULL`).get(p).n;
  if (!showAll) where.push('o.slip_filename IS NOT NULL');
  const page = Math.max(1, int(q.page, 1)); const per = 30;
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${where.join(' AND ')}`).get(p).n;
  const orders = db.prepare(`SELECT o.*, u.display_name,
      (SELECT GROUP_CONCAT(product_name || CASE WHEN size_label <> '' THEN ' (' || size_label || ')' ELSE '' END || ' x' || qty, ', ') FROM order_items WHERE order_id = o.id) AS items_text,
      (SELECT MIN(start_at) FROM order_items WHERE order_id = o.id) AS first_start,
      (SELECT MAX(due_at) FROM order_items WHERE order_id = o.id) AS last_due
    FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`).all(p);
  res.render('admin/orders', { title: 'คำสั่งซื้อ', orders, total, page, pages: Math.ceil(total / per), showAll, hiddenCount });
});

function loadOrder(req, res, next) {
  const o = O.getOrderByCode(req.params.code);
  if (!o) return res.status(404).render('error', { title: 'ไม่พบคำสั่งซื้อ', message: req.params.code, status: 404 });
  req.order = o; next();
}

router.get('/orders/:code', loadOrder, (req, res) => {
  const o = req.order;
  const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(o.user_id);
  const items = O.getItems(o.id);
  const events = db.prepare('SELECT e.*, u.display_name FROM order_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE order_id = ? ORDER BY e.id DESC').all(o.id);
  const notifications = db.prepare('SELECT * FROM notifications WHERE order_id = ? ORDER BY id DESC').all(o.id);
  const sync = db.prepare('SELECT * FROM sheet_sync WHERE order_id = ?').get(o.id);
  const slips = events.filter((e) => e.type === 'slip_uploaded').map((e) => JSON.parse(e.data || '{}').filename).filter(Boolean);
  res.render('admin/order', { title: `Order ${o.code}`, o, customer, items, events, notifications, sync, slips, durations: A.durationOptions() });
});

const back = (req, res, msg) => { if (msg) res.flash('success', msg); res.redirect(`/admin/orders/${req.order.code}`); };
const loadOrderAsync = (fn) => [loadOrder, wrap(fn)];
const notifText = (n) => (!n ? '' : n.status === 'sent' ? ' — ส่ง LINE แจ้งลูกค้าแล้ว' : n.status === 'failed' ? ` — ส่ง LINE ไม่สำเร็จ: ${n.error}` : ` — ไม่ได้ส่ง LINE (${n.error})`);
router.post('/orders/:code/approve', loadOrder, wrap(async (req, res) => {
  const n = await O.approve(req.order, req.user);
  res.flash(n && n.status === 'sent' ? 'success' : 'warn', `ยืนยันคำสั่งจองแล้ว${notifText(n)}`);
  back(req, res);
}));
const withNotice = (fn, msg) => loadOrderAsync(async (req, res) => {
  const n = await fn(req);
  res.flash(!n || n.status === 'sent' ? 'success' : 'warn', `${msg}${notifText(n)}`);
  back(req, res);
});
router.post('/orders/:code/reject', withNotice((req) => O.reject(req.order, req.user, req.body.reason), 'ปฏิเสธคำสั่งจองและคืนสต็อกแล้ว'));
router.post('/orders/:code/request-slip', withNotice((req) => O.requestNewSlip(req.order, req.user, req.body.reason), 'ขอสลิปใหม่จากลูกค้าแล้ว (สต็อกยังถูกล็อก)'));
router.post('/orders/:code/cancel', withNotice((req) => O.cancel(req.order, req.user, String(req.body.reason || '').trim() || 'ร้านยกเลิกคำสั่งซื้อ'), 'ยกเลิกคำสั่งซื้อและคืนสต็อกแล้ว'));
router.post('/orders/:code/returned', loadOrder, (req, res) => { O.markReturned(req.order, req.user); back(req, res, 'บันทึกรับคืนชุดแล้ว'); });
router.post('/orders/:code/completed', loadOrder, (req, res) => { O.markCompleted(req.order, req.user); back(req, res, 'คำสั่งซื้อเสร็จสิ้น ชุดพร้อมให้เช่าต่อ'); });
router.post('/orders/:code/shipping', loadOrder, wrap(async (req, res) => {
  const r = await O.updateShipping(req.order, req.user, req.body);
  res.flash(!r.notification || r.notification.status === 'sent' ? 'success' : 'warn', `อัปเดตการจัดส่งแล้ว${notifText(r.notification)}`);
  back(req, res);
}));
router.post('/orders/:code/items/:itemId', loadOrder, (req, res) => {
  O.editItem(req.order, int(req.params.itemId), req.user, { startAt: T.parseLocal(req.body.start), days: int(req.body.days), qty: int(req.body.qty) });
  back(req, res, 'แก้ไขข้อมูลการจองแล้ว');
});
router.post('/orders/:code/note', loadOrder, (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (note) require('../lib/audit').orderEvent(req.order.id, req.user, 'note', `บันทึกภายใน: ${note}`);
  back(req, res, 'บันทึกหมายเหตุแล้ว');
});
router.post('/orders/:code/contact', loadOrder, (req, res) => {
  const f = ['recipient_name', 'phone', 'address', 'province', 'district', 'subdistrict', 'postcode'];
  const before = Object.fromEntries(f.map((k) => [k, req.order[k]]));
  const after = Object.fromEntries(f.map((k) => [k, String(req.body[k] ?? before[k]).trim().slice(0, 300)]));
  db.prepare(`UPDATE orders SET ${f.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...after, now: Date.now(), id: req.order.id });
  require('../lib/audit').orderEvent(req.order.id, req.user, 'contact_edited', 'แก้ไขข้อมูลผู้รับ/ที่อยู่จัดส่ง', { before, after });
  sheets.markDirty(req.order.id);
  back(req, res, 'แก้ไขข้อมูลผู้รับแล้ว');
});

// ---------------------------------------------------------------- Users
router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM orders WHERE user_id = u.id) orders,
    (SELECT COALESCE(SUM(total),0) FROM orders WHERE user_id = u.id AND payment_status = 'approved') spent FROM users u ORDER BY u.id DESC`).all();
  res.render('admin/users', { title: 'ลูกค้า & สิทธิ์', users, envAdmins: config.adminLineIds });
});
router.post('/users/:id/role', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.redirect('/admin/users');
  if (u.id === req.user.id) { res.flash('error', 'ไม่สามารถเปลี่ยนสิทธิ์ของตัวเองได้'); return res.redirect('/admin/users'); }
  if (config.adminLineIds.includes(u.line_user_id)) { res.flash('error', 'บัญชีนี้ถูกกำหนดเป็น Admin ใน ADMIN_LINE_USER_IDS (.env)'); return res.redirect('/admin/users'); }
  const role = req.body.role === 'admin' ? 'admin' : 'customer';
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  audit(req, 'set_role', 'user', u.id, { role: u.role }, { role });
  res.flash('success', `เปลี่ยนสิทธิ์ ${u.display_name} เป็น ${role}`);
  res.redirect('/admin/users');
});

// ---------------------------------------------------------------- Settings
const settingsUpload = imageUploader('settings', { maxMb: 5 });
router.get('/settings', (req, res) => res.render('admin/settings', { title: 'ตั้งค่าร้าน', keys: Object.keys(DEFAULT_SETTINGS) }));
router.post('/settings', settingsUpload.single('payment_qr'), (req, res) => {
  const before = { ...getSettings() };
  const allowed = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'payment_qr_image');
  const next = {};
  for (const k of allowed) if (req.body[k] !== undefined) next[k] = String(req.body[k]).trim();
  // shop-wide promotion
  next.shop_promo_type = ['percent', 'amount'].includes(req.body.shop_promo_type) ? req.body.shop_promo_type : '';
  next.shop_promo_value = next.shop_promo_type ? String(Math.max(0, int(req.body.shop_promo_value))) : '';
  if (next.shop_promo_type === 'percent' && Number(next.shop_promo_value) > 100) throw new O.BookingError('ส่วนลดเปอร์เซ็นต์ต้องไม่เกิน 100%');
  if (next.shop_promo_type && !Number(next.shop_promo_value)) throw new O.BookingError('กรุณาใส่มูลค่าส่วนลดของโปรโมชั่นทั้งร้าน');
  next.shop_promo_start = next.shop_promo_type && req.body.shop_promo_start ? String(T.parseLocal(req.body.shop_promo_start) || '') : '';
  next.shop_promo_end = next.shop_promo_type && req.body.shop_promo_end ? String(T.parseLocal(req.body.shop_promo_end) || '') : '';
  next.shop_promo_label = next.shop_promo_type ? String(req.body.shop_promo_label || '').trim().slice(0, 60) : '';
  for (const k of ['auto_expire_unreviewed', 'notify_admin_slip', 'notify_admin_return']) next[k] = req.body[k] ? '1' : '0';
  for (const k of ['ems_fee', 'payment_hold_minutes', 'slip_reupload_minutes', 'return_reminder_hours', 'parcel_extra_hours', 'admin_review_hours', 'buffer_before_hours', 'buffer_after_hours', 'pickup_start_hour', 'pickup_end_hour', 'min_advance_hours', 'max_advance_days']) {
    if (next[k] !== undefined && !/^\d+$/.test(next[k])) throw new O.BookingError(`ค่า ${k} ต้องเป็นตัวเลข`);
  }
  if (Number(next.pickup_start_hour) > 23 || Number(next.pickup_end_hour) > 23 || Number(next.pickup_start_hour) > Number(next.pickup_end_hour)) throw new O.BookingError('ช่วงเวลารับ/คืนชุดไม่ถูกต้อง');
  if (Number(next.payment_hold_minutes) < 5 || Number(next.slip_reupload_minutes) < 5) throw new O.BookingError('เวลาล็อกสต็อก/เวลาอัปโหลดสลิปใหม่ต้องไม่น้อยกว่า 5 นาที');
  if (next.duration_options !== undefined) {
    const d = next.duration_options.split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0 && x <= 60);
    if (!d.length) throw new O.BookingError('กรุณาระบุระยะเวลาเช่าอย่างน้อย 1 ค่า');
    next.duration_options = [...new Set(d)].sort((a, b) => a - b).join(',');
  }
  if (next.promptpay_id && !promptpay.normalizeTarget(next.promptpay_id)) throw new O.BookingError('PromptPay ID ไม่ถูกต้อง (เบอร์มือถือ 10 หลัก / เลขประจำตัว 13 หลัก)');
  const [qr] = verifyImages(req.file ? [req.file] : []);
  if (qr) { removeFile('settings', before.payment_qr_image); next.payment_qr_image = qr.filename; }
  if (req.body.remove_qr) { removeFile('settings', before.payment_qr_image); next.payment_qr_image = ''; }
  setSettings(next);
  audit(req, 'update', 'settings', null, before, next);
  res.flash('success', 'บันทึกการตั้งค่าแล้ว');
  res.redirect('/admin/settings');
});

// ---------------------------------------------------------------- Integrations / system
router.get('/system', (req, res) => {
  const notifications = db.prepare('SELECT n.*, o.code FROM notifications n LEFT JOIN orders o ON o.id = n.order_id ORDER BY n.id DESC LIMIT 30').all();
  const syncStats = db.prepare('SELECT status, COUNT(*) n, SUM(dirty) d FROM sheet_sync GROUP BY status').all();
  const syncErrors = db.prepare("SELECT s.*, o.code FROM sheet_sync s JOIN orders o ON o.id = s.order_id WHERE s.status = 'failed' ORDER BY s.order_id DESC LIMIT 10").all();
  res.render('admin/system', {
    title: 'ระบบ & การเชื่อมต่อ', notifications, syncStats, syncErrors, backups: backup.list(), resetPhrase: RESET_PHRASE,
    orderCount: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    status: {
      lineLogin: config.lineLoginConfigured, lineMessaging: config.lineMessagingConfigured, sheets: config.sheetsConfigured,
      callback: line.callbackUrl(), baseUrl: config.baseUrl, devLogin: config.devLogin, serviceEmail: config.sheets.serviceEmail,
      sheetName: config.sheets.sheetName, sheetUrl: sheets.sheetUrl(), adminIds: config.adminLineIds.length, oa: config.line.oaBasicId,
    },
  });
});
router.post('/system/sheets-sync', wrap(async (req, res) => {
  const r = req.body.all ? await sheets.resyncAll() : await sheets.processQueue(500);
  res.flash(r.notConfigured ? 'error' : 'success', r.notConfigured ? 'ยังไม่ได้ตั้งค่า Google Sheets ใน .env — ข้อมูลยังรออยู่ในคิวและจะซิงก์เมื่อตั้งค่าเสร็จ' : `ซิงก์สำเร็จ ${r.ok || 0} รายการ, ล้มเหลว ${r.fail || 0}`);
  res.redirect('/admin/system');
}));
router.post('/system/line-test', wrap(async (req, res) => {
  if (!config.lineMessagingConfigured) { res.flash('error', 'ยังไม่ได้ตั้งค่า LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'); return res.redirect('/admin/system'); }
  if (req.user.line_user_id.startsWith('dev-')) { res.flash('error', 'บัญชีนี้เป็น Dev Login — กรุณาเข้าสู่ระบบด้วย LINE จริงเพื่อทดสอบ'); return res.redirect('/admin/system'); }
  try { await line.push(req.user.line_user_id, [{ type: 'text', text: `ทดสอบการแจ้งเตือนจาก ${getSettings().shop_name} ✅` }]); res.flash('success', 'ส่งข้อความทดสอบไปยัง LINE ของคุณแล้ว'); } catch (e) { res.flash('error', `ส่งไม่สำเร็จ: ${e.message}`); }
  res.redirect('/admin/system');
}));
router.post('/system/backup', wrap(async (req, res) => {
  const b = await backup.runBackup('manual');
  audit(req, 'backup', 'database', b.name);
  res.flash('success', `สำรองข้อมูลแล้ว: ${b.name}`);
  res.redirect('/admin/system');
}));
// Danger zone: wipe every order (e.g. test orders before going live). Products, customers and settings stay.
const RESET_PHRASE = 'ลบออเดอร์ทั้งหมด';
router.post('/system/reset-orders', wrap(async (req, res) => {
  if (String(req.body.confirm || '').trim() !== RESET_PHRASE) {
    res.flash('error', `พิมพ์คำว่า “${RESET_PHRASE}” ให้ตรงก่อนกดยืนยัน — ยังไม่ได้ลบอะไร`);
    return res.redirect('/admin/system#reset');
  }
  const b = await backup.runBackup('before-reset');   // safety net: the full database as it was
  const slips = db.prepare('SELECT slip_filename f FROM orders WHERE slip_filename IS NOT NULL').all().map((r) => r.f);
  const n = db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    db.prepare('DELETE FROM notifications WHERE order_id IS NOT NULL').run();
    db.prepare('DELETE FROM sheet_sync').run();
    db.prepare('DELETE FROM order_events').run();
    db.prepare('DELETE FROM order_items').run();
    db.prepare('DELETE FROM orders').run();
    if (req.body.carts) db.prepare('DELETE FROM cart_items').run();
    return count;
  })();
  slips.forEach((f) => removeFile('slips', f));
  audit(req, 'reset_orders', 'database', null, undefined, { orders: n, backup: b.name, carts: !!req.body.carts });
  res.flash('success', `ลบคำสั่งซื้อทั้งหมด ${n} รายการแล้ว — สต็อกทุกชุดกลับมาว่าง · สำรองข้อมูลก่อนลบไว้ที่ ${b.name}`);
  res.redirect('/admin/system#reset');
}));
router.get('/system/backups/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!backup.list().some((b) => b.name === name)) return res.status(404).end();
  audit(req, 'download_backup', 'database', name);
  res.download(path.join(config.backupDir, name));
});
router.post('/system/run-jobs', (req, res) => {
  const r = O.runExpiryJob();
  res.flash('success', `ตรวจสอบคำสั่งซื้อหมดเวลา: หมดอายุ ${r.expired} รายการ, เกินเวลาตรวจสอบ ${r.overdue} รายการ`);
  res.redirect('/admin/system');
});

router.get('/audit', (req, res) => {
  const logs = db.prepare('SELECT a.*, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all();
  res.render('admin/audit', { title: 'ประวัติการแก้ไขข้อมูล', logs });
});

module.exports = router;
