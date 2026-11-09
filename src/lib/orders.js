'use strict';
const crypto = require('crypto');
const { db, settingNum, getSettings } = require('../db');
const A = require('./availability');
const { unitPrice, listPrice } = require('./pricing');
const { orderEvent } = require('./audit');
const line = require('./line');
const sheets = require('./sheets');
const T = require('./time');
const L = require('./labels');

class BookingError extends Error {
  constructor(message, details) { super(message); this.details = details; this.isBookingError = true; }
}

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  const p = T.localParts(Date.now());
  const ymd = `${String(p.y).slice(2)}${T.pad(p.m)}${T.pad(p.d)}`;
  for (;;) {
    let r = '';
    const bytes = crypto.randomBytes(4);
    for (const b of bytes) r += ALPHA[b % ALPHA.length];
    const code = `RT${ymd}-${r}`;
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code)) return code;
  }
}

const getSkuFull = db.prepare(`SELECT s.*, p.name AS product_name, p.base_price, p.base_days, p.extra_day_price,
  p.buffer_before_hours, p.buffer_after_hours, p.is_active, p.deleted_at AS product_deleted
  FROM skus s JOIN products p ON p.id = s.product_id WHERE s.id = ?`);

function getOrder(id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); }
function getOrderByCode(code) { return db.prepare('SELECT * FROM orders WHERE code = ?').get(code); }
function getItems(orderId) { return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId); }

/**
 * Evaluate the cart for display (price, due date, availability per line).
 * Lines of the same SKU whose windows overlap are counted together.
 */
function evaluateCart(userId, now = Date.now()) {
  const rows = db.prepare(`SELECT c.*, s.size_label, s.product_id, s.deleted_at AS sku_deleted, p.name AS product_name,
      (SELECT filename FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1) AS image
    FROM cart_items c JOIN skus s ON s.id = c.sku_id JOIN products p ON p.id = s.product_id
    WHERE c.user_id = ? ORDER BY c.id`).all(userId);
  const lines = [];
  for (const r of rows) {
    const sku = getSkuFull.get(r.sku_id);
    const w = A.windowFor(sku, r.start_at, r.days);
    const price = unitPrice(sku, r.days);
    let error = null;
    let available = 0;
    if (sku.deleted_at || sku.product_deleted || !sku.is_active) error = 'สินค้านี้ไม่เปิดให้เช่าแล้ว';
    else {
      error = A.validateRentalRequest(r.start_at, r.days, now);
      available = A.availableQty(r.sku_id, w.blockStart, w.blockEnd, { now });
      // subtract earlier cart lines for the same SKU that overlap this window
      for (const prev of lines) {
        if (prev.sku_id === r.sku_id && prev.window.blockStart < w.blockEnd && prev.window.blockEnd > w.blockStart) available -= prev.qty;
      }
      available = Math.max(0, available);
      if (!error && available < r.qty) error = available === 0 ? 'ไม่ว่างในช่วงเวลาที่เลือก' : `ว่างเพียง ${available} ชิ้นในช่วงเวลานี้`;
    }
    lines.push({ ...r, window: w, unitPrice: price, listPrice: listPrice(sku, r.days), lineTotal: price * r.qty, available, error });
  }
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  return { lines, subtotal, ok: lines.length > 0 && lines.every((l) => !l.error) };
}

function shippingFee(method) {
  return method === 'ems' ? settingNum('ems_fee', 0) : 0;
}

/**
 * Create an order from the user's cart and lock (hold) the stock — atomically.
 * Runs inside BEGIN IMMEDIATE, so no other writer can book between the check and the insert.
 */
function createOrderFromCart(user, ship, now = Date.now()) {
  const tx = db.transaction(() => {
    const cart = db.prepare('SELECT * FROM cart_items WHERE user_id = ? ORDER BY id').all(user.id);
    if (!cart.length) throw new BookingError('ตะกร้าสินค้าว่าง');
    const fee = shippingFee(ship.shipping_method);
    const holdUntil = now + settingNum('payment_hold_minutes', 60) * 60000;
    const code = newCode();
    const info = db.prepare(`INSERT INTO orders(code, user_id, status, payment_status, subtotal, shipping_fee, total, shipping_method,
        recipient_name, phone, address, province, district, subdistrict, postcode, customer_note, hold_expires_at, created_at, updated_at)
      VALUES (@code, @user_id, 'awaiting_payment', 'unpaid', 0, @fee, 0, @shipping_method, @recipient_name, @phone, @address,
        @province, @district, @subdistrict, @postcode, @customer_note, @hold, @now, @now)`).run({
      ...ship, code, user_id: user.id, fee, hold: holdUntil, now, customer_note: ship.customer_note || null,
    });
    const orderId = info.lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO order_items(order_id, sku_id, product_id, product_name, size_label, qty, start_at, days, due_at,
      block_start, block_end, unit_price, line_total, list_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let subtotal = 0;
    const problems = [];
    for (const c of cart) {
      const sku = getSkuFull.get(c.sku_id);
      if (!sku || sku.deleted_at || sku.product_deleted || !sku.is_active) { problems.push(`${sku ? sku.product_name : 'สินค้า'}: ไม่เปิดให้เช่าแล้ว`); continue; }
      const err = A.validateRentalRequest(c.start_at, c.days, now);
      if (err) { problems.push(`${sku.product_name} (${sku.size_label}): ${err}`); continue; }
      const w = A.windowFor(sku, c.start_at, c.days, ship.shipping_method);
      // items already inserted for this order are visible to this query → same-SKU lines are counted together
      const avail = A.availableQty(c.sku_id, w.blockStart, w.blockEnd, { sku, now });
      if (avail < c.qty) { problems.push(`${sku.product_name} (${sku.size_label}): ${avail === 0 ? 'ไม่ว่างในช่วงเวลาที่เลือก' : `ว่างเพียง ${avail} ชิ้น`}`); continue; }
      const price = unitPrice(sku, c.days);
      insItem.run(orderId, sku.id, sku.product_id, sku.product_name, sku.size_label, c.qty, w.startAt, c.days, w.dueAt, w.blockStart, w.blockEnd, price, price * c.qty, listPrice(sku, c.days));
      subtotal += price * c.qty;
    }
    if (problems.length) throw new BookingError('สินค้าบางรายการไม่สามารถจองได้', problems);
    db.prepare('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?').run(subtotal, subtotal + fee, orderId);
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(user.id);
    orderEvent(orderId, user, 'created', `สร้างคำสั่งจองและล็อกสต็อกชั่วคราวถึง ${T.dt(holdUntil)}`);
    db.prepare("INSERT INTO sheet_sync(order_id, dirty, status) VALUES (?, 1, 'pending')").run(orderId);
    return orderId;
  });
  const id = tx.immediate();
  sheets.markDirty(id);
  return getOrder(id);
}

function assertStatus(order, allowed) {
  if (!allowed.includes(order.status)) throw new BookingError(`ไม่สามารถทำรายการนี้ได้ในสถานะ "${L.ORDER_STATUS[order.status].th}"`);
}

function uploadSlip(order, user, filename, now = Date.now()) {
  const res = db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['awaiting_payment']);
    if (o.hold_expires_at <= now) {
      db.prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?").run(now, o.id);
      orderEvent(o.id, null, 'expired', 'หมดเวลาชำระเงิน ระบบคืนสต็อกอัตโนมัติ');
      return 'expired';
    }
    const reviewDue = now + settingNum('admin_review_hours', 24) * 3600000;
    db.prepare(`UPDATE orders SET status = 'pending_approval', payment_status = 'submitted', slip_filename = ?, slip_uploaded_at = ?,
      review_due_at = ?, review_overdue = 0, updated_at = ? WHERE id = ?`).run(filename, now, reviewDue, now, o.id);
    orderEvent(o.id, user, 'slip_uploaded', 'ลูกค้าอัปโหลดสลิปการโอนเงิน รอแอดมินตรวจสอบ', { filename });
    return 'ok';
  }).immediate();
  sheets.markDirty(order.id);
  if (res === 'expired') throw new BookingError('หมดเวลาชำระเงินแล้ว สต็อกถูกคืนเข้าระบบ กรุณาทำรายการจองใหม่');
  // admins are alerted only once the slip is in (nothing to review before that); fire-and-forget
  Promise.resolve(line.adminSlipUploaded(getOrder(order.id))).catch((e) => console.error('[line] admin alert', e.message));
}

const SYSTEM = { id: null, role: 'system' };

async function approve(order, admin) {
  db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['pending_approval']);
    if (!o.slip_filename) throw new BookingError('ยังไม่มีสลิปการโอนเงิน');
    const now = Date.now();
    db.prepare(`UPDATE orders SET status = 'confirmed', payment_status = 'approved', confirmed_at = ?, review_overdue = 0,
      shipping_status = COALESCE(shipping_status, 'preparing'), updated_at = ? WHERE id = ?`).run(now, now, o.id);
    orderEvent(o.id, admin, 'confirmed', 'แอดมินยืนยันการชำระเงินและคำสั่งจอง สต็อกถูกจัดสรรแล้ว');
  }).immediate();
  sheets.markDirty(order.id);
  return line.bookingConfirmed(getOrder(order.id));
}

async function reject(order, admin, reason) {
  if (!reason || !reason.trim()) throw new BookingError('กรุณาระบุเหตุผลในการปฏิเสธ');
  db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['awaiting_payment', 'pending_approval']);
    const now = Date.now();
    db.prepare(`UPDATE orders SET status = 'rejected', payment_status = CASE WHEN slip_filename IS NULL THEN payment_status ELSE 'rejected' END,
      reject_reason = ?, updated_at = ? WHERE id = ?`).run(reason.trim(), now, o.id);
    orderEvent(o.id, admin, 'rejected', `ปฏิเสธคำสั่งจอง: ${reason.trim()} — คืนสต็อกที่ล็อกไว้`);
  }).immediate();
  sheets.markDirty(order.id);
  return line.orderRejected(getOrder(order.id), reason.trim());
}

/** Slip is wrong/unclear: keep the booking, ask the customer to upload a new slip. */
async function requestNewSlip(order, admin, reason) {
  if (!reason || !reason.trim()) throw new BookingError('กรุณาระบุเหตุผล');
  db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['pending_approval']);
    const now = Date.now();
    const hold = now + settingNum('slip_reupload_minutes', 60) * 60000;
    db.prepare(`UPDATE orders SET status = 'awaiting_payment', payment_status = 'rejected', reject_reason = ?, hold_expires_at = ?,
      updated_at = ? WHERE id = ?`).run(reason.trim(), hold, now, o.id);
    orderEvent(o.id, admin, 'slip_rejected', `สลิปไม่ผ่านการตรวจสอบ: ${reason.trim()} — ให้ลูกค้าอัปโหลดใหม่ภายใน ${T.dt(hold)}`);
  }).immediate();
  sheets.markDirty(order.id);
  return line.slipRejected(getOrder(order.id), reason.trim());
}

async function cancel(order, actor, reason) {
  db.transaction(() => {
    const o = getOrder(order.id);
    const allowed = actor.role === 'admin' ? ['awaiting_payment', 'pending_approval', 'confirmed'] : ['awaiting_payment'];
    assertStatus(o, allowed);
    const now = Date.now();
    // payment that was already approved stays 'approved' (money received → refund handled outside the system)
    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, reject_reason = COALESCE(?, reject_reason),
      payment_status = CASE WHEN payment_status = 'approved' THEN 'approved' ELSE 'cancelled' END, updated_at = ? WHERE id = ?`)
      .run(now, reason || null, now, o.id);
    orderEvent(o.id, actor, 'cancelled', `ยกเลิกคำสั่งจอง${reason ? `: ${reason}` : ''} — คืนสต็อก`);
  }).immediate();
  sheets.markDirty(order.id);
  // the customer cancelling their own order doesn't need a message; admin cancellations do
  if (actor.role === 'admin') return line.orderCancelled(getOrder(order.id), reason || 'ร้านยกเลิกคำสั่งซื้อ');
  return null;
}

function returnMethodsFor(order) {
  return L.EXPRESS_ONLY_RETURN_PROVINCES.includes(order.province) ? ['express'] : ['parcel', 'express'];
}

/** Customer tells the shop how the clothes are being sent back (can be updated until the shop receives them). */
async function submitReturn(order, user, { method, carrier, carrierOther, tracking, note }) {
  const o = getOrder(order.id);
  assertStatus(o, ['confirmed']);
  const allowed = returnMethodsFor(o);
  if (!allowed.includes(method)) {
    throw new BookingError(allowed.length === 1 ? `ลูกค้าใน${o.province}ต้องส่งคืนแบบ${L.RETURN_METHOD.express}เท่านั้น` : 'กรุณาเลือกวิธีส่งคืน');
  }
  let carrierName = null;
  if (method === 'parcel') {
    carrierName = carrier === L.CARRIER_OTHER ? String(carrierOther || '').trim().slice(0, 60) : carrier;
    if (!carrierName || (carrier !== L.CARRIER_OTHER && !L.CARRIERS.includes(carrier))) throw new BookingError('กรุณาเลือกหรือระบุบริษัทขนส่ง');
  }
  const t = String(tracking || '').trim().slice(0, 500);
  if (t.length < 3) throw new BookingError('กรุณาใส่เลขพัสดุหรือลิงก์ติดตามการจัดส่ง');
  const n = String(note || '').trim().slice(0, 500) || null;
  const first = !o.return_submitted_at;
  const now = Date.now();
  db.prepare('UPDATE orders SET return_method = ?, return_carrier = ?, return_tracking = ?, return_note = ?, return_submitted_at = ?, updated_at = ? WHERE id = ?')
    .run(method, carrierName, t, n, now, now, o.id);
  orderEvent(o.id, user, 'return_submitted', `${first ? 'ลูกค้าแจ้งส่งคืนชุด' : 'ลูกค้าแก้ไขข้อมูลส่งคืน'}: ${L.RETURN_METHOD[method]}${carrierName ? ` (${carrierName})` : ''} · ${t}${n ? ` · หมายเหตุ: ${n}` : ''}`);
  sheets.markDirty(o.id);
  Promise.resolve(line.adminReturnSubmitted(getOrder(o.id), first)).catch((e) => console.error('[line] admin alert', e.message));
  return getOrder(o.id);
}

/**
 * Shop received the clothes. Each item stays unavailable for its cleaning buffer counted from now
 * (frees stock early on early returns, protects it on late returns); the order then completes by itself.
 */
function markReturned(order, admin) {
  const now = Date.now();
  db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['confirmed']);
    db.prepare("UPDATE orders SET status = 'returned', returned_at = ?, updated_at = ? WHERE id = ?").run(now, now, o.id);
    for (const it of getItems(o.id)) {
      const p = db.prepare('SELECT buffer_before_hours, buffer_after_hours FROM products WHERE id = ?').get(it.product_id);
      const after = A.productBuffers(p).after;
      db.prepare('UPDATE order_items SET block_end = ? WHERE id = ?').run(Math.max(now + after * 3600000, it.block_start + 1), it.id);
    }
    const late = getItems(o.id).some((i) => i.due_at < now);
    const until = Math.max(...getItems(o.id).map((i) => i.block_end));
    orderEvent(o.id, admin, 'returned', `รับคืนชุดแล้ว${late ? ' (คืนล่าช้ากว่ากำหนด)' : ''} — ตรวจสอบ/ทำความสะอาดถึง ${T.dt(until)} แล้วระบบจะปิดออเดอร์ให้อัตโนมัติ`);
  }).immediate();
  sheets.markDirty(order.id);
}

function markCompleted(order, admin) {
  const now = Date.now();
  const o = getOrder(order.id);
  assertStatus(o, ['returned']);
  db.prepare("UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, o.id);
  orderEvent(o.id, admin, 'completed', 'ตรวจสอบ/ทำความสะอาดเสร็จ ชุดพร้อมให้เช่าต่อ — คำสั่งซื้อเสร็จสิ้น');
  sheets.markDirty(o.id);
}

async function updateShipping(order, admin, f) {
  const o = getOrder(order.id);
  assertStatus(o, ['confirmed', 'returned', 'completed']);
  if (f.shipping_status && !L.SHIPPING_STATUS[f.shipping_status]) throw new BookingError('สถานะจัดส่งไม่ถูกต้อง');
  if (f.shipping_method && !L.SHIPPING_METHOD[f.shipping_method]) throw new BookingError('วิธีจัดส่งไม่ถูกต้อง');
  const before = { shipping_carrier: o.shipping_carrier, shipping_method: o.shipping_method, shipping_status: o.shipping_status, tracking_number: o.tracking_number, express_provider: o.express_provider, express_info: o.express_info, shipped_at: o.shipped_at, shipping_note: o.shipping_note };
  const next = {
    shipping_method: f.shipping_method || o.shipping_method,
    shipping_status: f.shipping_status || o.shipping_status || 'preparing',
    tracking_number: (f.tracking_number || '').trim() || null,
    shipping_carrier: (f.shipping_carrier === L.CARRIER_OTHER ? String(f.shipping_carrier_other || '').trim().slice(0, 60) : (f.shipping_carrier || '').trim()) || null,
    express_provider: (f.express_provider || '').trim() || null,
    express_info: (f.express_info || '').trim() || null,
    shipping_note: (f.shipping_note || '').trim() || null,
    shipped_at: f.shipped_at ? T.parseLocal(f.shipped_at) : o.shipped_at,
  };
  const idx = (s) => L.SHIPPING_ORDER.indexOf(s);
  const becameShipped = idx(next.shipping_status) >= idx('shipped') && idx(o.shipping_status) < idx('shipped');
  if (becameShipped && !next.shipped_at) next.shipped_at = Date.now();
  if (next.shipping_method === 'ems' && becameShipped && !next.tracking_number) throw new BookingError('กรุณาระบุเลขพัสดุ (Tracking Number) ก่อนเปลี่ยนสถานะเป็นจัดส่งแล้ว');
  const delivered = next.shipping_status === 'delivered' && o.shipping_status !== 'delivered' ? Date.now() : o.delivered_at;
  db.prepare(`UPDATE orders SET shipping_method=@shipping_method, shipping_carrier=@shipping_carrier, shipping_status=@shipping_status, tracking_number=@tracking_number,
    express_provider=@express_provider, express_info=@express_info, shipping_note=@shipping_note, shipped_at=@shipped_at,
    delivered_at=@delivered, updated_at=@now WHERE id=@id`).run({ ...next, delivered, now: Date.now(), id: o.id });
  const changes = Object.keys(next).filter((k) => String(before[k] ?? '') !== String(next[k] ?? ''));
  if (changes.length) {
    orderEvent(o.id, admin, 'shipping', `อัปเดตการจัดส่ง: ${L.SHIPPING_STATUS[next.shipping_status].th}${next.shipping_carrier ? ` · ${next.shipping_carrier}` : ''}${next.tracking_number ? ` · Tracking ${next.tracking_number}` : ''}`, { before, after: next });
  }
  sheets.markDirty(o.id);
  const notification = becameShipped ? await line.shipped(getOrder(o.id)) : null;
  return { becameShipped, notification };
}

/** Admin edits an item's rental period / quantity. Re-checks stock excluding this item. */
function editItem(order, itemId, admin, { startAt, days, qty }) {
  db.transaction(() => {
    const o = getOrder(order.id);
    assertStatus(o, ['awaiting_payment', 'pending_approval', 'confirmed']);
    const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, o.id);
    if (!item) throw new BookingError('ไม่พบรายการสินค้า');
    if (!Number.isFinite(startAt)) throw new BookingError('วันเวลาเริ่มเช่าไม่ถูกต้อง');
    if (!(days > 0) || !(qty > 0)) throw new BookingError('จำนวนวัน/จำนวนชิ้นไม่ถูกต้อง');
    const sku = getSkuFull.get(item.sku_id);
    const w = A.windowFor(sku, startAt, days, o.shipping_method);
    const avail = A.availableQty(item.sku_id, w.blockStart, w.blockEnd, { sku, excludeItemId: item.id });
    if (avail < qty) throw new BookingError(`สต็อกไม่พอในช่วงเวลาใหม่ (ว่าง ${avail} ชิ้น)`);
    const price = unitPrice(sku, days);
    db.prepare(`UPDATE order_items SET start_at=?, days=?, due_at=?, block_start=?, block_end=?, qty=?, unit_price=?, line_total=?, list_price=?, return_reminded_at=NULL WHERE id=?`)
      .run(w.startAt, days, w.dueAt, w.blockStart, w.blockEnd, qty, price, price * qty, listPrice(sku, days), item.id);
    const subtotal = db.prepare('SELECT SUM(line_total) s FROM order_items WHERE order_id = ?').get(o.id).s;
    db.prepare('UPDATE orders SET subtotal = ?, total = ? + shipping_fee, updated_at = ? WHERE id = ?').run(subtotal, subtotal, Date.now(), o.id);
    orderEvent(o.id, admin, 'item_edited', `แก้ไขการจอง ${item.product_name} (${item.size_label}): ${T.dt(item.start_at)}/${item.days} วัน/x${item.qty} → ${T.dt(w.startAt)}/${days} วัน/x${qty}`,
      { before: item, after: { startAt: w.startAt, days, qty, dueAt: w.dueAt } });
  }).immediate();
  sheets.markDirty(order.id);
}

/** Background job: release expired holds, flag overdue reviews. */
/**
 * LINE the customer `return_reminder_hours` before the return deadline (once per item).
 * Only for confirmed orders that haven't been returned yet and whose deadline hasn't passed.
 */
async function runReturnReminders(now = Date.now()) {
  const hours = settingNum('return_reminder_hours', 3);
  if (!(hours > 0)) return { sent: 0 };
  const rows = db.prepare(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'confirmed' AND oi.return_reminded_at IS NULL AND oi.due_at > ? AND oi.due_at <= ?
    ORDER BY oi.order_id, oi.due_at`).all(now, now + hours * 3600000);
  const byOrder = new Map();
  for (const r of rows) { if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []); byOrder.get(r.order_id).push(r); }
  let sent = 0;
  for (const [orderId, items] of byOrder) {
    // mark first so a slow LINE call can't cause a second reminder on the next tick
    const mark = db.prepare('UPDATE order_items SET return_reminded_at = ? WHERE id = ? AND return_reminded_at IS NULL');
    db.transaction(() => items.forEach((i) => mark.run(now, i.id)))();
    const order = getOrder(orderId);
    const n = await line.returnReminder(order, items, now);
    orderEvent(orderId, SYSTEM, 'return_reminder', `แจ้งเตือนลูกค้าก่อนครบกำหนดคืนชุด (${items.map((i) => i.product_name).join(', ')})${n && n.status !== 'sent' ? ` — ไม่ได้ส่ง LINE: ${n.error || n.status}` : ''}`);
    sent++;
  }
  return { sent };
}

/** Returned orders whose cleaning period has ended become 'completed' automatically. */
function runAutoComplete(now = Date.now()) {
  const done = db.prepare(`SELECT o.id FROM orders o WHERE o.status = 'returned'
    AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.block_end > ?)`).all(now);
  for (const { id } of done) {
    db.prepare("UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'returned'").run(now, now, id);
    orderEvent(id, SYSTEM, 'completed', 'ครบช่วงตรวจสอบ/ทำความสะอาด — ชุดพร้อมให้เช่าต่อ ระบบปิดออเดอร์อัตโนมัติ');
    sheets.markDirty(id);
  }
  return { completed: done.length };
}

function runExpiryJob(now = Date.now()) {
  const expired = db.prepare("SELECT id FROM orders WHERE status = 'awaiting_payment' AND hold_expires_at <= ?").all(now);
  const autoExpire = getSettings().auto_expire_unreviewed === '1';
  const overdue = db.prepare("SELECT id FROM orders WHERE status = 'pending_approval' AND review_due_at <= ? AND review_overdue = 0").all(now);
  db.transaction(() => {
    for (const { id } of expired) {
      db.prepare("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?").run(now, id);
      orderEvent(id, null, 'expired', 'ลูกค้าไม่ชำระเงิน/ไม่อัปโหลดสลิปภายในเวลาที่กำหนด ระบบปลดล็อกสต็อกอัตโนมัติ');
    }
    for (const { id } of overdue) {
      if (autoExpire) {
        db.prepare("UPDATE orders SET status = 'expired', review_overdue = 1, updated_at = ? WHERE id = ?").run(now, id);
        orderEvent(id, null, 'expired', 'แอดมินไม่ได้ตรวจสอบภายในเวลาที่กำหนด ระบบปลดล็อกสต็อกอัตโนมัติ (ตามการตั้งค่า)');
      } else {
        db.prepare('UPDATE orders SET review_overdue = 1, updated_at = ? WHERE id = ?').run(now, id);
        orderEvent(id, null, 'review_overdue', 'เกินเวลาตรวจสอบที่กำหนด — สต็อกยังถูกล็อกไว้ รอแอดมินดำเนินการ');
      }
    }
  })();
  for (const { id } of [...expired, ...(autoExpire ? overdue : [])]) sheets.markDirty(id);
  return { expired: expired.length, overdue: overdue.length };
}

module.exports = { BookingError, evaluateCart, shippingFee, createOrderFromCart, uploadSlip, approve, reject, requestNewSlip, cancel, markReturned, markCompleted, updateShipping, editItem, runExpiryJob, runReturnReminders, runAutoComplete, submitReturn, returnMethodsFor, getOrder, getOrderByCode, getItems };
