'use strict';
/**
 * Google Sheets mirror of orders (one row per order, keyed by Order ID in column A).
 * The system database is the source of truth; the sheet is a reporting copy.
 * Changes are queued in `sheet_sync` (dirty flag) and pushed by a background worker,
 * so a Google outage never blocks bookings. Rows are located by Order ID before writing,
 * which prevents duplicates even if the stored row number is stale.
 */
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');
const T = require('./time');
const L = require('./labels');

const HEADERS = ['Order ID', 'วันที่-เวลาสั่งจอง', 'ชื่อลูกค้า', 'เบอร์โทรศัพท์', 'รายละเอียดสินค้า', 'ไซส์', 'จำนวน',
  'วันเริ่มเช่า', 'วันและเวลาที่ต้องคืน', 'ระยะเวลาเช่า', 'ค่าเช่า (บาท)', 'ค่าจัดส่ง (บาท)', 'ยอดชำระ (บาท)', 'วิธีจัดส่ง',
  'สถานะการชำระเงิน', 'สถานะคำสั่งซื้อ', 'สถานะจัดส่ง', 'Tracking Number', 'อัปเดตล่าสุด', 'ส่งคืน: วิธี', 'ส่งคืน: เลขพัสดุ/ลิงก์'];
const LAST_COL = String.fromCharCode(64 + HEADERS.length); // 'S'

let tokenCache = { token: null, exp: 0 };
let headerChecked = false;

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: config.sheets.serviceEmail, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), config.sheets.privateKey));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google auth ${res.status}: ${j.error_description || j.error || ''}`);
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.token;
}

async function api(method, pathAndQuery, body) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.sheets.spreadsheetId}${pathAndQuery}`;
  const res = await fetch(url, {
    method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(j.error && j.error.message) || ''}`);
  return j;
}

const range = (r) => encodeURIComponent(`'${config.sheets.sheetName.replace(/'/g, "''")}'!${r}`);

async function ensureHeader() {
  if (headerChecked) return;
  const meta = await api('GET', '?fields=sheets.properties.title');
  const exists = (meta.sheets || []).some((s) => s.properties.title === config.sheets.sheetName);
  if (!exists) await api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: config.sheets.sheetName } } }] });
  await api('PUT', `/values/${range(`A1:${LAST_COL}1`)}?valueInputOption=RAW`, { values: [HEADERS] });
  headerChecked = true;
}

function buildRow(orderId) {
  const o = db.prepare('SELECT o.*, u.display_name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?').get(orderId);
  if (!o) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  const j = (f) => items.map(f).join('\n');
  return [o.code, T.dt(o.created_at), o.recipient_name, o.phone,
    j((i) => i.product_name), j((i) => i.size_label), j((i) => String(i.qty)),
    j((i) => T.dt(i.start_at)), j((i) => T.dt(i.due_at)), j((i) => `${i.days} วัน (${i.days * 24} ชม.)`),
    o.subtotal, o.shipping_fee, o.total, L.SHIPPING_METHOD[o.shipping_method],
    (L.PAYMENT_STATUS[o.payment_status] || {}).th || o.payment_status,
    (L.ORDER_STATUS[o.status] || {}).th || o.status,
    o.shipping_status ? L.SHIPPING_STATUS[o.shipping_status].th : '-',
    o.tracking_number || '', T.dt(Date.now()), o.return_method ? L.RETURN_METHOD[o.return_method] : '', o.return_tracking || '']; // valueInputOption=RAW → never evaluated as formulas
}

async function findRow(code) {
  const j = await api('GET', `/values/${range('A:A')}?majorDimension=COLUMNS`);
  const col = (j.values && j.values[0]) || [];
  const idx = col.findIndex((v) => v === code);
  return idx >= 0 ? idx + 1 : null;
}

async function syncOne(orderId) {
  const row = buildRow(orderId);
  if (!row) { db.prepare('DELETE FROM sheet_sync WHERE order_id = ?').run(orderId); return; }
  await ensureHeader();
  const rec = db.prepare('SELECT * FROM sheet_sync WHERE order_id = ?').get(orderId) || {};
  let rowNum = rec.row_number || null;
  if (rowNum) {
    const chk = await api('GET', `/values/${range(`A${rowNum}`)}`);
    if (!(chk.values && chk.values[0] && chk.values[0][0] === row[0])) rowNum = null;
  }
  if (!rowNum) rowNum = await findRow(row[0]);
  if (rowNum) {
    await api('PUT', `/values/${range(`A${rowNum}:${LAST_COL}${rowNum}`)}?valueInputOption=RAW`, { values: [row] });
  } else {
    const r = await api('POST', `/values/${range(`A:${LAST_COL}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] });
    const m = /![A-Z]+(\d+)/.exec((r.updates && r.updates.updatedRange) || '');
    rowNum = m ? Number(m[1]) : null;
  }
  db.prepare("UPDATE sheet_sync SET row_number = ?, dirty = 0, status = 'synced', last_error = NULL, synced_at = ? WHERE order_id = ?").run(rowNum, Date.now(), orderId);
}

function markDirty(orderId) {
  db.prepare(`INSERT INTO sheet_sync(order_id, dirty, status) VALUES (?, 1, 'pending')
    ON CONFLICT(order_id) DO UPDATE SET dirty = 1, status = CASE WHEN status = 'not_configured' THEN status ELSE 'pending' END`).run(orderId);
  setImmediate(() => processQueue().catch(() => {}));
}

let running = false;
async function processQueue(limit = 25) {
  if (running) return { skipped: true };
  running = true;
  let ok = 0; let fail = 0;
  try {
    const rows = db.prepare('SELECT order_id FROM sheet_sync WHERE dirty = 1 AND attempts < 20 ORDER BY order_id LIMIT ?').all(limit);
    if (!config.sheetsConfigured) {
      db.prepare("UPDATE sheet_sync SET status = 'not_configured' WHERE dirty = 1").run();
      return { notConfigured: true, pending: rows.length };
    }
    for (const r of rows) {
      try { await syncOne(r.order_id); ok++; } catch (e) {
        fail++;
        db.prepare("UPDATE sheet_sync SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE order_id = ?").run(e.message.slice(0, 500), r.order_id);
        console.error('[sheets]', e.message);
        if (/auth|40[13]/.test(e.message)) break;
      }
    }
  } finally { running = false; }
  return { ok, fail };
}

function resyncAll() {
  db.prepare("INSERT OR IGNORE INTO sheet_sync(order_id, dirty, status) SELECT id, 1, 'pending' FROM orders").run();
  db.prepare("UPDATE sheet_sync SET dirty = 1, attempts = 0, status = 'pending'").run();
  headerChecked = false;
  return processQueue(1000);
}

function sheetUrl() {
  return config.sheets.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${config.sheets.spreadsheetId}/edit` : '';
}

module.exports = { markDirty, processQueue, resyncAll, sheetUrl, buildRow, HEADERS };
