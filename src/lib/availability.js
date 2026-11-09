'use strict';
/**
 * Time-based stock availability.
 *
 * Every SKU (product + size) owns `stock_qty` physical units. A unit is occupied by
 *   - an order item whose order is still active, for [block_start, block_end)
 *     where block_start = rental start - prep buffer and block_end = due + cleaning buffer
 *   - an admin block (cleaning / repair / offline booking), for [start_at, end_at)
 *
 * Available units for a window = stock_qty - (maximum number of units simultaneously occupied
 * at any instant inside the window). A sweep-line is used so that two bookings that don't
 * overlap each other don't both count against the same window.
 */
const { db, settingNum, getSettings } = require('../db');
const { rentalWindow, HOUR, localParts } = require('./time');

const ACTIVE_ORDER_SQL = `(o.status IN ('pending_approval','confirmed','returned')
  OR (o.status = 'awaiting_payment' AND o.hold_expires_at > @now))`;

function productBuffers(product) {
  return {
    before: product && product.buffer_before_hours != null ? product.buffer_before_hours : settingNum('buffer_before_hours', 24),
    after: product && product.buffer_after_hours != null ? product.buffer_after_hours : settingNum('buffer_after_hours', 48),
  };
}

/**
 * Occupancy window of one booking. Parcel orders keep the dress out longer
 * (return transit by post) → `parcel_extra_hours` is added after the cleaning buffer.
 */
function windowFor(product, startAt, days, shippingMethod = 'express') {
  const b = productBuffers(product);
  const extra = shippingMethod === 'ems' ? settingNum('parcel_extra_hours', 72) : 0;
  return rentalWindow(startAt, days, b.before, b.after + extra);
}

const qItems = db.prepare(`
  SELECT oi.block_start AS s, oi.block_end AS e, oi.qty AS q, o.status, o.id AS order_id
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.sku_id = @sku AND oi.block_start < @to AND oi.block_end > @from
    AND ${ACTIVE_ORDER_SQL} AND o.id != @exclude AND oi.id != @excludeItem`);
const qBlocks = db.prepare(`
  SELECT start_at AS s, end_at AS e, qty AS q FROM sku_blocks
  WHERE sku_id = @sku AND start_at < @to AND end_at > @from`);
const qSku = db.prepare('SELECT * FROM skus WHERE id = ? AND deleted_at IS NULL');

// bookings the shop has confirmed (payment approved) — used to tell "busy" apart from "awaiting confirmation"
const qItemsConfirmed = db.prepare(`
  SELECT oi.block_start AS s, oi.block_end AS e, oi.qty AS q, o.status, o.id AS order_id
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.sku_id = @sku AND oi.block_start < @to AND oi.block_end > @from AND o.status IN ('confirmed','returned')`);

function intervals(skuId, from, to, excludeOrderId = 0, now = Date.now(), excludeItemId = 0, confirmedOnly = false) {
  const p = { sku: skuId, from, to, exclude: excludeOrderId || 0, excludeItem: excludeItemId || 0, now };
  if (confirmedOnly) return [...qItemsConfirmed.all(p).map((r) => ({ ...r, kind: 'order' })), ...qBlocks.all(p).map((r) => ({ ...r, kind: 'block' }))];
  return [...qItems.all(p).map((r) => ({ ...r, kind: 'order' })), ...qBlocks.all(p).map((r) => ({ ...r, kind: 'block' }))];
}

function maxConcurrent(list, from, to) {
  const ev = [];
  for (const it of list) {
    const s = Math.max(it.s, from);
    const e = Math.min(it.e, to);
    if (e <= s) continue;
    ev.push([s, it.q], [e, -it.q]);
  }
  // end events sort before start events at the same instant: [a,b) and [b,c) do not overlap
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let max = 0;
  for (const [, d] of ev) { cur += d; if (cur > max) max = cur; }
  return max;
}

/** Units of a SKU free during the whole [from, to) window. */
function availableQty(skuId, from, to, opts = {}) {
  const sku = opts.sku || qSku.get(skuId);
  if (!sku) return 0;
  const used = maxConcurrent(intervals(skuId, from, to, opts.excludeOrderId, opts.now || Date.now(), opts.excludeItemId, opts.confirmedOnly), from, to);
  return Math.max(0, sku.stock_qty - used);
}

/**
 * Validate the customer's chosen start time and duration against shop rules.
 * Returns an error message (Thai) or null.
 */
function validateRentalRequest(startAt, days, now = Date.now()) {
  const s = getSettings();
  if (!Number.isFinite(startAt)) return 'กรุณาเลือกวันและเวลาเริ่มเช่า';
  const options = durationOptions();
  if (!Number.isInteger(days) || !options.includes(days)) return `ระยะเวลาเช่าต้องเป็น ${options.join(', ')} วัน`;
  const minAdv = Number(s.min_advance_hours) || 0;
  if (startAt < now + minAdv * HOUR) return `ต้องจองล่วงหน้าอย่างน้อย ${minAdv} ชั่วโมง`;
  const maxAdv = Number(s.max_advance_days) || 365;
  if (startAt > now + maxAdv * 24 * HOUR) return `จองล่วงหน้าได้ไม่เกิน ${maxAdv} วัน`;
  const { h, mi } = localParts(startAt);
  const open = Number(s.pickup_start_hour); const close = Number(s.pickup_end_hour);
  const minutes = h * 60 + mi;
  if (minutes < open * 60 || minutes > close * 60) return `เวลาเริ่มเช่า/คืนชุดต้องอยู่ระหว่าง ${String(open).padStart(2, '0')}:00–${String(close).padStart(2, '0')}:00 น.`;
  return null;
}

function durationOptions() {
  return String(getSettings().duration_options || '3').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0).sort((a, b) => a - b);
}

/**
 * Breakdown of a SKU's units right now (for the admin inventory page).
 */
function skuStatusNow(skuId, now = Date.now()) {
  const sku = qSku.get(skuId);
  if (!sku) return null;
  const rows = db.prepare(`
    SELECT o.status, oi.qty, oi.start_at, oi.due_at, oi.block_start, oi.block_end, o.shipping_status
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.sku_id = @sku AND oi.block_end > @now AND ${ACTIVE_ORDER_SQL}`).all({ sku: skuId, now });
  let held = 0; let booked = 0; let renting = 0; let cleaning = 0;
  for (const r of rows) {
    const nowIn = r.block_start <= now && now < r.block_end;
    if (r.status === 'awaiting_payment' || r.status === 'pending_approval') { held += r.qty; continue; }
    booked += r.qty;
    if (nowIn && r.status === 'returned') cleaning += r.qty;
    else if (nowIn) renting += r.qty;
  }
  const blocks = db.prepare('SELECT reason, qty FROM sku_blocks WHERE sku_id = ? AND start_at <= ? AND end_at > ?').all(skuId, now, now);
  const blockedNow = blocks.reduce((a, b) => a + b.qty, 0);
  const freeNow = availableQty(skuId, now, now + 1, { sku, now });
  return { stock: sku.stock_qty, held, booked, renting, cleaning, blockedNow, blocks, freeNow };
}

/** Move a time to the next allowed start (inside pickup hours, on a :00/:30 slot). */
function roundToOpen(t) {
  const st = getSettings();
  const open = Number(st.pickup_start_hour); const close = Number(st.pickup_end_hour);
  t = Math.ceil(t / (30 * 60000)) * 30 * 60000;
  for (let i = 0; i < 400; i++) {
    const { h, mi } = localParts(t);
    const m = h * 60 + mi;
    if (m >= open * 60 && m <= close * 60) return t;
    // jump to opening time (same day if before opening, otherwise next day)
    const dayStart = t - (m * 60000);
    t = (m < open * 60 ? dayStart : dayStart + 24 * HOUR) + open * HOUR;
  }
  return t;
}

/**
 * Earliest start (>= fromStart) at which `qty` units of any of the given SKUs are free for `days`.
 * Candidates are fromStart and every time an existing booking/block releases a unit.
 * Returns { startAt, skuId } or null.
 */
function nextAvailable(product, skus, fromStart, days, qty = 1, now = Date.now()) {
  const minStart = roundToOpen(Math.max(fromStart, now + settingNum('min_advance_hours', 0) * HOUR));
  const b = productBuffers(product);
  const horizon = now + settingNum('max_advance_days', 180) * 24 * HOUR;
  const cands = new Set([minStart]);
  for (const sku of skus) {
    for (const iv of intervals(sku.id, minStart - b.before * HOUR, horizon, 0, now)) {
      if (iv.e + b.before * HOUR > minStart) cands.add(roundToOpen(iv.e + b.before * HOUR));
    }
  }
  const fits = (t) => {
    const w = windowFor(product, t, days);
    const sku = skus.find((s) => s.stock_qty >= qty && availableQty(s.id, w.blockStart, w.blockEnd, { sku: s, now }) >= qty);
    return sku ? { startAt: t, skuId: sku.id } : null;
  };
  const sorted = [...cands].filter((t) => t <= horizon).sort((a, c) => a - c).slice(0, 60);
  for (const t of sorted) { const r = fits(t); if (r) return r; }
  // fallback: step through the calendar (every 3h) in case the candidate list missed a gap
  for (let t = minStart, i = 0; t <= horizon && i < 1500; t = roundToOpen(t + 3 * HOUR), i++) { const r = fits(t); if (r) return r; }
  return null;
}

module.exports = { roundToOpen, nextAvailable, ACTIVE_ORDER_SQL, productBuffers, windowFor, intervals, maxConcurrent, availableQty, validateRentalRequest, durationOptions, skuStatusNow };
