'use strict';
/* Products with several sizes: admin saves sizes, catalog filters by any matching size, sizes with bookings can't be deleted. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-var-'));
Object.assign(process.env, {
  DB_FILE: path.join(tmp, 'var.db'), DATA_DIR: tmp, UPLOAD_DIR: path.join(tmp, 'up'), BACKUP_DIR: path.join(tmp, 'bk'),
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


const form = (extra) => ({ name: 'Duo Dress', is_active: '1', tier_days: '1', tier_price: '500', ...extra });
const skusOf = (pid) => db.prepare('SELECT * FROM skus WHERE product_id = ? AND deleted_at IS NULL ORDER BY sort').all(pid);

test('admin creates a product with two sizes, each with its own measurements', async () => {
  const admin = new Client(); await admin.login('Boss', 'admin');
  const r = await admin.post('/admin/products', form({
    var_keys: 'n0,n1',
    var_n0_size: 'S', var_n0_stock: '1', var_n0_bust: '32', var_n0_bust_max: '34', var_n0_hip_free: '1',
    var_n1_size: 'M', var_n1_stock: '2', var_n1_bust: '35', var_n1_length: '40',
  }), '/admin/products/new');
  assert.equal(r.status, 302);
  const pid = Number(r.location.split('/').pop());
  const s = skusOf(pid);
  assert.deepEqual(s.map((x) => [x.size_label, x.stock_qty, x.bust, x.bust_max, x.hip_free]), [['S', 1, 32, 34, 1], ['M', 2, 35, null, 0]]);
  // catalog: both sizes searchable, conditions must match the SAME size
  const shop = new Client();
  const titles = async (qs) => [...(await shop.get('/' + qs)).text.matchAll(/class="title">([^<]+)</g)].map((m) => m[1].trim());
  assert.ok((await titles('?size=M')).includes('Duo Dress'));
  assert.ok((await titles('?bmin=33&bmax=33')).includes('Duo Dress'));          // S is 32–34
  assert.ok(!(await titles('?size=M&bmin=33&bmax=33')).includes('Duo Dress')); // M is 35
  assert.ok((await titles('?size=S&hfs=1')).includes('Duo Dress'));
  assert.ok(!(await titles('?size=XL')).includes('Duo Dress'));
  // product page offers both sizes
  const page = (await shop.get(`/products/${pid}`)).text;
  assert.ok(page.includes('data-measures-for="' + s[0].id + '"') && page.includes('data-measures-for="' + s[1].id + '"'));

  // duplicate size rejected
  const keys = s.map((x) => 'e' + x.id).join(',');
  const dup = { var_keys: keys, [`var_e${s[0].id}_id`]: s[0].id, [`var_e${s[0].id}_size`]: 'M', [`var_e${s[0].id}_stock`]: '1', [`var_e${s[1].id}_id`]: s[1].id, [`var_e${s[1].id}_size`]: 'M', [`var_e${s[1].id}_stock`]: '2' };
  await admin.post(`/admin/products/${pid}`, form(dup), `/admin/products/${pid}`);
  assert.deepEqual(skusOf(pid).map((x) => x.size_label), ['S', 'M']);

  // swap sizes between rows (unique index must not trip)
  const swap = { ...dup, [`var_e${s[0].id}_size`]: 'M', [`var_e${s[1].id}_size`]: 'S' };
  await admin.post(`/admin/products/${pid}`, form(swap), `/admin/products/${pid}`);
  assert.deepEqual(skusOf(pid).map((x) => x.size_label), ['M', 'S']);

  // a size with an unfinished booking can't be removed; others can
  const now = Date.now();
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const oid = db.prepare(`INSERT INTO orders(code, user_id, status, payment_status, subtotal, shipping_fee, total, shipping_method, recipient_name, phone, address, province, district, subdistrict, postcode, created_at, updated_at)
    VALUES ('VAR1', ?, 'confirmed', 'paid', 500, 0, 500, 'ems', 'A', '0800000000', 'x', 'กรุงเทพมหานคร', 'ปทุมวัน', 'ปทุมวัน', '10330', ?, ?)`).run(uid, now, now).lastInsertRowid;
  db.prepare(`INSERT INTO order_items(order_id, product_id, sku_id, product_name, size_label, qty, unit_price, line_total, days, start_at, due_at, block_start, block_end)
    VALUES (?, ?, ?, 'Duo Dress', 'M', 1, 500, 500, 1, ?, ?, ?, ?)`).run(oid, pid, s[0].id, now + 9e7, now + 18e7, now + 9e7, now + 3e8);
  const rm = (id) => ({ ...swap, [`var_e${id}_remove`]: '1' });
  await admin.post(`/admin/products/${pid}`, form(rm(s[0].id)), `/admin/products/${pid}`);
  assert.equal(skusOf(pid).length, 2, 'booked size kept');
  await admin.post(`/admin/products/${pid}`, form(rm(s[1].id)), `/admin/products/${pid}`);
  assert.deepEqual(skusOf(pid).map((x) => x.size_label), ['M']);
});

test('single-size form (no var_keys) still works', async () => {
  const admin = new Client(); await admin.login('Boss', 'admin');
  const r = await admin.post('/admin/products', form({ name: 'Solo', size: 'L', stock_qty: '3', waist: '28' }), '/admin/products/new');
  const pid = Number(r.location.split('/').pop());
  assert.deepEqual(skusOf(pid).map((x) => [x.size_label, x.stock_qty, x.waist]), [['L', 3, 28]]);
  assert.equal(db.prepare('SELECT size FROM products WHERE id = ?').get(pid).size, 'L');
});
