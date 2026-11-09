'use strict';
const L = require('./labels');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function orderBadge(status) {
  const s = L.ORDER_STATUS[status] || { th: status, tone: 'muted' };
  return `<span class="badge ${s.tone}">${esc(s.th)}</span>`;
}
function paymentBadge(status) {
  const s = L.PAYMENT_STATUS[status] || { th: status, tone: 'muted' };
  return `<span class="badge ${s.tone}">${esc(s.th)}</span>`;
}
function shippingBadge(status) {
  if (!status) return '<span class="badge muted">-</span>';
  const tone = { preparing: 'warn', shipped: 'info', in_transit: 'info', delivered: 'ok' }[status];
  return `<span class="badge ${tone}">${esc(L.SHIPPING_STATUS[status].th)}</span>`;
}
/** Show customer-entered tracking text; http(s) URLs become links (other schemes stay plain text). */
function trackingHtml(text) {
  const t = String(text || '');
  return esc(t).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a class="link" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function carrierTrackUrl(carrier, number) {
  if (!number) return null;
  if (/ไปรษณีย์|EMS|Thailand Post/i.test(carrier || '') || (!carrier && /^[A-Z]{2}\d{9}TH$/i.test(number))) {
    return `https://track.thailandpost.co.th/?trackNumber=${encodeURIComponent(number)}`;
  }
  return null;
}
function img(filename) { return filename ? `/media/products/${encodeURIComponent(filename)}` : '/static/img/placeholder.svg'; }
function qs(query, patch) {
  const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === '' || q[k] == null) delete q[k];
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '?';
}

/** " (ไซส์ X)" for legacy sized items; '' when the item has no size (current one-size-per-dress model). */
function sz(label, withWord = false) { return label ? ` (${withWord ? 'ไซส์ ' : ''}${label})` : ''; }

/** One measurement value for display: number (inches), 'Freesize', or null when not set. */
function measureValue(p, col) {
  if (p[`${col}_free`]) return 'Freesize';
  const v = p[col];
  return v == null || v === '' ? null : String(Math.round(Number(v) * 10) / 10);
}

/** Measurements text, e.g. "B 34 · W 28 · H Freesize · L 40" (numbers are inches). */
function measures(p) {
  const parts = [['B', 'bust'], ['W', 'waist'], ['H', 'hip'], ['L', 'length']]
    .map(([k, col]) => [k, measureValue(p, col)]).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`);
  return parts.join(' · ');
}

module.exports = { sz, measures, measureValue, carrierTrackUrl, trackingHtml, esc, orderBadge, paymentBadge, shippingBadge, img, qs };
