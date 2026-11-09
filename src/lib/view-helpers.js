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
function img(filename) { return filename ? `/media/products/${encodeURIComponent(filename)}` : '/static/img/placeholder.svg'; }
function qs(query, patch) {
  const q = { ...query, ...patch };
  for (const k of Object.keys(q)) if (q[k] === '' || q[k] == null) delete q[k];
  const s = new URLSearchParams(q).toString();
  return s ? `?${s}` : '?';
}

module.exports = { trackingHtml, esc, orderBadge, paymentBadge, shippingBadge, img, qs };
