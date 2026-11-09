'use strict';
/* End-to-end HTTP test: customer books → stock locked → second customer blocked → slip → admin approves → ships. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-e2e-'));
Object.assign(process.env, {
  DB_FILE: path.join(tmp, 'e2e.db'), DATA_DIR: tmp, UPLOAD_DIR: path.join(tmp, 'up'), BACKUP_DIR: path.join(tmp, 'bk'),
  DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'test', LINE_LOGIN_CHANNEL_ID: '', LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: '', GOOGLE_SHEETS_SPREADSHEET_ID: '',
  DOTENV_PATH: path.join(tmp, 'none.env'),
});
const { db, setSettings } = require('../src/db');
const T = require('../src/lib/time');
const app = require('../src/server');

let base; let server;
test.before(async () => {
  server = app.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  setSettings({ promptpay_id: '0812345678' });
  const now = Date.now();
  const pid = db.prepare(`INSERT INTO products(name, base_price, base_days, extra_day_price, buffer_before_hours, buffer_after_hours, is_active, created_at, updated_at)
    VALUES ('Test Gown', 1000, 3, 200, 24, 48, 1, ?, ?)`).run(now, now).lastInsertRowid;
  db.prepare("INSERT INTO skus(product_id, size_label, stock_qty) VALUES (?, 'M', 1)").run(pid);
});
test.after(() => server.close());

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { cookie: this.cookie, ...(opts.headers || {}) };
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.startsWith('rental.sid=')) this.cookie = kv; }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }
  get(u) { return this.req('GET', u); }
  async csrf(u = '/login') {
    for (const p of [u, '/account', '/login']) {
      const m = /name="_csrf" value="([^"]+)"/.exec((await this.get(p)).text);
      if (m) return m[1];
    }
    throw new Error('no csrf');
  }
  async post(u, body, page) { const _csrf = await this.csrf(page); return this.req('POST', u, { ...body, _csrf }); }
  async login(name, role) { const r = await this.post('/auth/dev-login', { name, role }); assert.equal(r.status, 302); return r; }
}

const startDate = T.toInputDate(Date.now() + 10 * T.DAY);
const sku = () => db.prepare("SELECT id FROM skus WHERE size_label = 'M'").get().id;
const ship = { recipient_name: 'สมหญิง ใจดี', phone: '0812345678', address: '99/1 ถนนพระราม 1', province: 'กรุงเทพมหานคร', district: 'ปทุมวัน', subdistrict: 'ปทุมวัน', postcode: '10330', shipping_method: 'ems' };
let orderCode;

test('customer cannot access admin; dev login works', async () => {
  const c = new Client();
  const r = await c.login('Alice', 'customer');
  assert.equal(r.location, '/');
  const a = await c.get('/admin');
  assert.equal(a.status, 403);
});

test('availability API reflects stock and computes due date', async () => {
  const c = new Client();
  const r = JSON.parse((await c.get(`/api/availability?sku=${sku()}&date=${startDate}&time=09:00&days=3`)).text);
  assert.equal(r.ok, true); assert.equal(r.available, 1); assert.equal(r.hours, 72); assert.equal(r.unitPrice, 1000);
  const bad = JSON.parse((await c.get(`/api/availability?sku=${sku()}&date=${startDate}&time=22:00&days=3`)).text);
  assert.equal(bad.ok, false);
});

test('booking flow locks stock and prevents double booking', async () => {
  const alice = new Client(); await alice.login('Alice', 'customer');
  const add = await alice.post('/cart/add', { sku_id: sku(), qty: 1, start_date: startDate, start_time: '09:00', days: 3, product_id: 1 }, '/products/1');
  assert.equal(add.location, '/cart');
  // adding a second unit of the only unit must fail (cart-aware check)
  const add2 = await alice.req('POST', '/cart/add', { sku_id: sku(), qty: 1, start_date: startDate, start_time: '10:00', days: 1, _csrf: await alice.csrf('/cart') }, { headers: { referer: base + '/products/1' } });
  assert.equal(add2.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 1);

  // Bob puts the same item in his cart before Alice checks out
  const bob = new Client(); await bob.login('Bob', 'customer');
  await bob.post('/cart/add', { sku_id: sku(), qty: 1, start_date: startDate, start_time: '12:00', days: 2, product_id: 1 }, '/products/1');

  // missing required fields → 422
  const bad = await alice.post('/checkout', { ...ship, postcode: '12' }, '/checkout');
  assert.equal(bad.status, 422);
  // district that doesn't belong to the province is rejected
  const badAddr = await alice.post('/checkout', { ...ship, district: 'เมืองเชียงใหม่' }, '/checkout');
  assert.equal(badAddr.status, 422);

  const co = await alice.post('/checkout', ship, '/checkout');
  assert.equal(co.status, 302);
  assert.match(co.location, /^\/orders\/RT\d{6}-[A-Z0-9]{4}\/pay$/);
  orderCode = co.location.split('/')[2];
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(orderCode);
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.total, 1080); // 1000 + EMS 80
  const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(o.id);
  assert.equal(item.due_at - item.start_at, 72 * T.HOUR);

  // catalog: held by an unconfirmed booking → yellow "awaiting confirmation", not red "busy"
  const cat1 = await alice.get(`/?start_date=${startDate}&start_time=09:00&days=3`);
  assert.ok(cat1.text.includes('รอยืนยันการชำระเงิน') && !cat1.text.includes('avail-badge">ไม่ว่าง'));
  const api1 = JSON.parse((await alice.get(`/api/availability?sku=${sku()}&date=${startDate}&time=09:00&days=3`)).text);
  assert.equal(api1.available, 0); assert.equal(api1.held, true);

  // Bob's checkout must now fail: overlapping window, stock 1 already held by Alice
  const coBob = await bob.post('/checkout', ship, '/checkout');
  assert.equal(coBob.status, 302); assert.equal(coBob.location, '/cart');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);

  // QR is generated for the order
  const pay = await alice.get(`/orders/${orderCode}/pay`);
  assert.equal(pay.status, 200); assert.ok(pay.text.includes('qr.png'));
  const qr = await fetch(`${base}/orders/${orderCode}/qr.png`, { headers: { cookie: alice.cookie } });
  assert.equal(qr.headers.get('content-type'), 'image/png');
  // other users can't see this order
  assert.equal((await bob.get(`/orders/${orderCode}`)).status, 404);
});

test('a later non-overlapping booking (after cleaning buffer) is allowed', async () => {
  const bob = new Client(); await bob.login('Bob', 'customer');
  db.prepare('DELETE FROM cart_items').run();
  // Alice (parcel): start D 09:00, due D+3 09:00, cleaning 48h + parcel 72h → free from D+8 09:00; Bob needs 24h prep → start ≥ D+9 09:00
  const tooEarly = T.toInputDate(T.parseLocal(startDate) + 8 * T.DAY);
  const ok = T.toInputDate(T.parseLocal(startDate) + 9 * T.DAY);
  const r1 = JSON.parse((await bob.get(`/api/availability?sku=${sku()}&date=${tooEarly}&time=09:00&days=1`)).text);
  assert.equal(r1.available, 0);
  const r2 = JSON.parse((await bob.get(`/api/availability?sku=${sku()}&date=${ok}&time=09:00&days=1`)).text);
  assert.equal(r2.available, 1);
});

test('slip upload → pending approval; admin approves and ships', async () => {
  const alice = new Client(); await alice.login('Alice', 'customer');
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300010000050001', 'hex');
  const fd = new FormData();
  fd.append('slip', new Blob([png], { type: 'image/png' }), 'slip.png');
  const token = await alice.csrf(`/orders/${orderCode}/pay`);
  const up = await alice.req('POST', `/orders/${orderCode}/slip?_csrf=${token}`, fd);
  assert.equal(up.status, 302);
  let o = db.prepare('SELECT * FROM orders WHERE code = ?').get(orderCode);
  assert.equal(o.status, 'pending_approval'); assert.equal(o.payment_status, 'submitted');

  // slip is private
  const anon = new Client();
  assert.notEqual((await anon.get(`/slips/${o.slip_filename}`)).status, 200);

  const admin = new Client();
  const lr = await admin.login('Owner', 'admin');
  assert.equal(lr.location, '/admin');
  assert.equal((await admin.get('/admin')).status, 200);
  assert.equal((await admin.get(`/admin/orders/${orderCode}`)).status, 200);
  assert.equal((await admin.get(`/slips/${o.slip_filename}`)).status, 200);

  const ap = await admin.post(`/admin/orders/${orderCode}/approve`, {}, `/admin/orders/${orderCode}`);
  assert.equal(ap.status, 302);
  o = db.prepare('SELECT * FROM orders WHERE code = ?').get(orderCode);
  assert.equal(o.status, 'confirmed'); assert.equal(o.payment_status, 'approved');
  // catalog: confirmed → red "busy" with an estimated free date
  const cat2 = await alice.get(`/?start_date=${startDate}&start_time=09:00&days=3`);
  assert.match(cat2.text, /avail-badge">ไม่ว่าง<small>ว่างประมาณ/);
  // LINE not configured → logged as skipped, never "sent"
  const n = db.prepare('SELECT * FROM notifications WHERE order_id = ?').get(o.id);
  assert.equal(n.status, 'skipped');

  // EMS shipped without tracking → rejected
  await admin.post(`/admin/orders/${orderCode}/shipping`, { shipping_method: 'ems', shipping_status: 'shipped' }, `/admin/orders/${orderCode}`);
  assert.equal(db.prepare('SELECT shipping_status FROM orders WHERE id = ?').get(o.id).shipping_status, 'preparing');
  await admin.post(`/admin/orders/${orderCode}/shipping`, { shipping_method: 'ems', shipping_status: 'shipped', tracking_number: 'EF123456789TH' }, `/admin/orders/${orderCode}`);
  o = db.prepare('SELECT * FROM orders WHERE code = ?').get(orderCode);
  assert.equal(o.shipping_status, 'shipped'); assert.ok(o.shipped_at);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE order_id = ? AND type = 'shipped'").get(o.id).n, 1);

  // customer sees tracking
  const page = await alice.get(`/orders/${orderCode}`);
  assert.ok(page.text.includes('EF123456789TH'));

  // all admin pages render
  for (const u of ['/admin/orders', '/admin/products', '/admin/products/1', '/admin/products/1/calendar', '/admin/inventory', '/admin/calendar', '/admin/users', '/admin/settings', '/admin/system', '/admin/audit', '/admin/categories', '/admin/products/new']) {
    const r = await admin.get(u); assert.equal(r.status, 200, u);
  }
  // returned → completed releases stock
  await admin.post(`/admin/orders/${orderCode}/returned`, {}, `/admin/orders/${orderCode}`);
  await admin.post(`/admin/orders/${orderCode}/completed`, {}, `/admin/orders/${orderCode}`);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'completed');
  const r = JSON.parse((await alice.get(`/api/availability?sku=${sku()}&date=${startDate}&time=09:00&days=3`)).text);
  assert.equal(r.available, 1);
  // history recorded
  assert.ok(db.prepare('SELECT COUNT(*) n FROM order_events WHERE order_id = ?').get(o.id).n >= 6);
  // sheets queue holds the order (not configured → never marked synced)
  assert.notEqual(db.prepare('SELECT status FROM sheet_sync WHERE order_id = ?').get(o.id).status, 'synced');
});

test('unpaid holds expire and release stock', async () => {
  const carol = new Client(); await carol.login('Carol', 'customer');
  await carol.post('/cart/add', { sku_id: sku(), qty: 1, start_date: startDate, start_time: '09:00', days: 3, product_id: 1 }, '/products/1');
  const co = await carol.post('/checkout', ship, '/checkout');
  const code = co.location.split('/')[2];
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(code);
  assert.equal(o.status, 'awaiting_payment');
  const { runExpiryJob } = require('../src/lib/orders');
  runExpiryJob(o.hold_expires_at + 1);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'expired');
});

test('requests without CSRF token are rejected', async () => {
  const c = new Client(); await c.login('Dan', 'customer');
  const r = await c.req('POST', '/cart/add', { sku_id: sku(), qty: 1 });
  assert.equal(r.status, 403);
});
