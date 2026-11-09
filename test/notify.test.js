'use strict';
/* Verifies LINE messages (content + who receives them) using a fake LINE API — no real network calls. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-notify-'));
Object.assign(process.env, {
  DB_FILE: path.join(tmp, 'n.db'), DATA_DIR: tmp, UPLOAD_DIR: path.join(tmp, 'up'), BACKUP_DIR: path.join(tmp, 'bk'),
  NODE_ENV: 'test', LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'test-token', GOOGLE_SHEETS_SPREADSHEET_ID: '', DOTENV_PATH: path.join(tmp, 'none.env'),
});

const sent = [];
global.fetch = async (url, opts) => {
  if (String(url).includes('api.line.me/v2/bot/message/push')) sent.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({}) };
};

const { db } = require('../src/db');
const T = require('../src/lib/time');
const O = require('../src/lib/orders');

function makeOrder(status = 'pending_approval') {
  const now = Date.now();
  const uid = db.prepare("INSERT INTO users(line_user_id, display_name, created_at) VALUES (?, 'ลูกค้า', ?)").run(`U${Math.random().toString(16).slice(2)}`, now).lastInsertRowid;
  const pid = db.prepare("INSERT INTO products(name, base_price, base_days, created_at, updated_at) VALUES ('Rosé Dress', 1000, 3, ?, ?)").run(now, now).lastInsertRowid;
  const sku = db.prepare("INSERT INTO skus(product_id, size_label, stock_qty) VALUES (?, 'M', 1)").run(pid).lastInsertRowid;
  const code = `RT-T${Math.random().toString(36).slice(2, 6)}`;
  const oid = db.prepare(`INSERT INTO orders(code, user_id, status, payment_status, subtotal, shipping_fee, total, shipping_method, recipient_name, phone, address, province, district, subdistrict, postcode,
    hold_expires_at, slip_filename, created_at, updated_at) VALUES (?, ?, ?, 'submitted', 1000, 80, 1080, 'ems', 'ก', '0812345678', 'x', 'กรุงเทพมหานคร', 'ปทุมวัน', 'ลุมพินี', '10330', ?, 's.png', ?, ?)`)
    .run(code, uid, status, now + 3600000, now, now).lastInsertRowid;
  const start = now + 10 * T.DAY;
  db.prepare(`INSERT INTO order_items(order_id, sku_id, product_id, product_name, size_label, qty, start_at, days, due_at, block_start, block_end, unit_price, line_total)
    VALUES (?, ?, ?, 'Rosé Dress', 'M', 1, ?, 3, ?, ?, ?, 1000, 1000)`).run(oid, sku, pid, start, start + 3 * T.DAY, start - T.DAY, start + 5 * T.DAY);
  return { order: O.getOrder(oid), userLineId: db.prepare('SELECT line_user_id FROM users WHERE id = ?').get(uid).line_user_id };
}
const admin = { id: null, role: 'admin' };

test('request new slip → LINE with reason, amount, new deadline and upload link', async () => {
  sent.length = 0;
  const { order, userLineId } = makeOrder();
  const n = await O.requestNewSlip(order, admin, 'ยอดเงินไม่ตรง');
  assert.equal(n.status, 'sent');
  const o = O.getOrder(order.id);
  const msg = sent[0];
  assert.equal(msg.to, userLineId);
  const text = msg.messages[0].text;
  assert.match(text, /สลิปการโอนเงินไม่ผ่านการตรวจสอบ/);
  assert.match(text, /เหตุผล: ยอดเงินไม่ตรง/);
  assert.match(text, /฿1,080/);
  assert.ok(text.includes(`ภายใน ${T.dt(o.hold_expires_at)}`), 'deadline included');
  assert.ok(text.includes(`/orders/${o.code}/pay`), 'upload link included');
  assert.equal(o.status, 'awaiting_payment');
});

test('reject order → LINE with reason and items', async () => {
  sent.length = 0;
  const { order } = makeOrder();
  const n = await O.reject(order, admin, 'ชุดอยู่ระหว่างซ่อม');
  assert.equal(n.status, 'sent');
  assert.match(sent[0].messages[0].text, /คำสั่งจองถูกปฏิเสธ[\s\S]*Rosé Dress[\s\S]*เหตุผล: ชุดอยู่ระหว่างซ่อม/);
  assert.equal(O.getOrder(order.id).status, 'rejected');
});

test('admin cancels → LINE with reason; customer self-cancel → no LINE', async () => {
  sent.length = 0;
  const a = makeOrder('confirmed');
  await O.cancel(a.order, admin, 'ลูกค้าแจ้งเลื่อนงาน');
  assert.equal(sent.length, 1);
  assert.match(sent[0].messages[0].text, /คำสั่งซื้อถูกยกเลิก[\s\S]*เหตุผล: ลูกค้าแจ้งเลื่อนงาน/);

  sent.length = 0;
  const b = makeOrder('awaiting_payment');
  const r = await O.cancel(b.order, { id: b.order.user_id, role: 'customer' }, 'ลูกค้ายกเลิกเอง');
  assert.equal(r, null);
  assert.equal(sent.length, 0);
});

test('reason is required for reject and request-slip', async () => {
  const { order } = makeOrder();
  await assert.rejects(() => O.reject(order, admin, '  '), /เหตุผล/);
  await assert.rejects(() => O.requestNewSlip(order, admin, ''), /เหตุผล/);
});

test('re-upload deadline is slip_reupload_minutes (default 60) from now', async () => {
  const { order } = makeOrder();
  const before = Date.now();
  await O.requestNewSlip(order, admin, 'รูปไม่ชัด');
  const hold = O.getOrder(order.id).hold_expires_at;
  assert.ok(hold >= before + 60 * 60000 && hold <= Date.now() + 60 * 60000, 'deadline = now + 60 min');
});

test('admins get LINE alerts for new order and uploaded slip (and can switch them off)', async () => {
  const { setSettings } = require('../src/db');
  const line = require('../src/lib/line');
  const now = Date.now();
  const adminLine = `Uadmin${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO users(line_user_id, display_name, role, created_at) VALUES (?, 'แอดมิน', 'admin', ?)").run(adminLine, now);
  db.prepare("INSERT INTO users(line_user_id, display_name, role, created_at) VALUES ('dev-admin-x', 'dev', 'admin', ?)").run(now);

  sent.length = 0;
  const { order } = makeOrder('awaiting_payment');
  await line.adminNewOrder(order);
  const toAdmin = sent.filter((m) => m.to === adminLine);
  assert.equal(toAdmin.length, 1, 'real admin notified once');
  assert.ok(!sent.some((m) => m.to === 'dev-admin-x'), 'dev accounts are not messaged');
  assert.match(toAdmin[0].messages[0].text, /ออเดอร์ใหม่[\s\S]*Rosé Dress[\s\S]*฿1,080[\s\S]*\/admin\/orders\//);

  sent.length = 0;
  O.uploadSlip(order, { id: order.user_id, role: 'customer' }, 'slip2.png');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sent.some((m) => m.to === adminLine && /มีสลิปรอตรวจสอบ/.test(m.messages[0].text)));

  sent.length = 0;
  setSettings({ notify_admin_new_order: '0' });
  assert.equal(line.adminNewOrder(order), null);
  assert.equal(sent.length, 0);
  setSettings({ notify_admin_new_order: '1' });
});
