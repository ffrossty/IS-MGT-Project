'use strict';
/**
 * Rental pricing.
 *
 * 1. Price table per product (price_tiers JSON: [{ days, price }]) e.g. 1 วัน 350 · 3 วัน 450 · 5 วัน 550
 *    - exact tier → that price
 *    - between tiers → the largest tier below + extra_day_price for each extra day
 *    - shorter than the smallest tier → the smallest tier's price
 *    Products without a table fall back to base_price for base_days (+ extra_day_price per extra day).
 * 2. Promotion (optional, time-limited): per-product and/or shop-wide, percent or fixed baht off.
 *    When both apply, the customer gets the bigger discount (they don't stack).
 */
const { db, getSettings } = require('../db');

const qProduct = db.prepare('SELECT * FROM products WHERE id = ?');

/** Accepts a product row or a SKU row joined with a few product columns; loads the full product when needed. */
function full(product) {
  if (product && product.price_tiers !== undefined && product.promo_type !== undefined) return product;
  const id = product && (product.product_id || product.id);
  return (id && qProduct.get(id)) || product;
}

function tiers(product) {
  const p = full(product);
  let list = [];
  try { list = JSON.parse(p.price_tiers || '[]'); } catch (_) { list = []; }
  list = list.map((t) => ({ days: parseInt(t.days, 10), price: Math.round(Number(t.price)) }))
    .filter((t) => t.days > 0 && Number.isFinite(t.price) && t.price >= 0)
    .sort((a, b) => a.days - b.days);
  if (!list.length) list = [{ days: p.base_days || 1, price: p.base_price || 0 }];
  return list;
}

/** Price before any promotion. */
function listPrice(product, days) {
  const p = full(product);
  const t = tiers(p);
  const exact = t.find((x) => x.days === days);
  if (exact) return exact.price;
  const below = t.filter((x) => x.days < days).pop();
  if (!below) return t[0].price;
  return below.price + (days - below.days) * (p.extra_day_price || 0);
}

function activePromo(type, value, start, end, label, now) {
  if (!['percent', 'amount'].includes(type) || !(Number(value) > 0)) return null;
  if (start && now < Number(start)) return null;
  if (end && now >= Number(end)) return null;
  return { type, value: Number(value), end: end ? Number(end) : null, label: label || '' };
}

function promotions(product, now = Date.now()) {
  const p = full(product);
  const s = getSettings();
  return [
    activePromo(p.promo_type, p.promo_value, p.promo_start, p.promo_end, p.promo_label, now),
    activePromo(s.shop_promo_type, s.shop_promo_value, s.shop_promo_start, s.shop_promo_end, s.shop_promo_label, now),
  ].filter(Boolean);
}

function applyPromo(price, promo) {
  const off = promo.type === 'percent' ? Math.round(price * Math.min(promo.value, 100) / 100) : Math.min(price, Math.round(promo.value));
  return price - off;
}

/** Full price breakdown for one unit. */
function priceDetail(product, days, now = Date.now()) {
  const original = listPrice(product, days);
  let best = null;
  for (const promo of promotions(product, now)) {
    const final = applyPromo(original, promo);
    if (!best || final < best.final) best = { final, promo };
  }
  if (!best || best.final >= original) return { price: original, original, discount: 0, promo: null };
  return {
    price: best.final, original, discount: original - best.final, promo: best.promo,
    percentOff: Math.round(((original - best.final) / original) * 100),
  };
}

/** Price the customer pays for one unit (promotion applied). */
function unitPrice(product, days, now = Date.now()) {
  return priceDetail(product, days, now).price;
}

const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });

module.exports = { unitPrice, priceDetail, listPrice, tiers, promotions, baht };
