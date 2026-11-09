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
  assert.equal(O.getOrder(a.order.id).payment_status, 'cancelled', 'unpaid/unapproved → payment shown as cancelled');

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

test('admins get a LINE alert only after the customer uploads a slip', async () => {
  const { setSettings } = require('../src/db');
  const line = require('../src/lib/line');
  assert.equal(line.adminNewOrder, undefined, 'no alert on order placement');
  const now = Date.now();
  const adminLine = `Uadmin${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO users(line_user_id, display_name, role, created_at) VALUES (?, 'แอดมิน', 'admin', ?)").run(adminLine, now);
  db.prepare("INSERT INTO users(line_user_id, display_name, role, created_at) VALUES ('dev-admin-x', 'dev', 'admin', ?)").run(now);

  sent.length = 0;
  const { order } = makeOrder('awaiting_payment');
  O.uploadSlip(order, { id: order.user_id, role: 'customer' }, 'slip2.png');
  await new Promise((r) => setTimeout(r, 50));
  const toAdmin = sent.filter((m) => m.to === adminLine);
  assert.equal(toAdmin.length, 1);
  assert.match(toAdmin[0].messages[0].text, /มีสลิปรอตรวจสอบ[\s\S]*Rosé Dress \(ไซส์ M\) x1[\s\S]*คืนภายใน[\s\S]*฿1,080[\s\S]*\/admin\/orders\//);
  assert.ok(!sent.some((m) => m.to === 'dev-admin-x'), 'dev accounts are not messaged');

  sent.length = 0;
  setSettings({ notify_admin_slip: '0' });
  const b = makeOrder('awaiting_payment');
  O.uploadSlip(b.order, { id: b.order.user_id, role: 'customer' }, 'slip3.png');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.filter((m) => m.to === adminLine).length, 0, 'switch off works');
  setSettings({ notify_admin_slip: '1' });
});

test('cancelling an already-approved order keeps payment as approved (refund case)', async () => {
  const { order } = makeOrder('confirmed');
  db.prepare("UPDATE orders SET payment_status = 'approved' WHERE id = ?").run(order.id);
  await O.cancel(O.getOrder(order.id), admin, 'ชุดเสียหาย');
  const o = O.getOrder(order.id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.payment_status, 'approved');
});

test('bookings may start 3 hours from now (default min advance)', () => {
  const A = require('../src/lib/availability');
  const now = T.parseLocal('2026-12-01', '08:00');
  assert.equal(A.validateRentalRequest(T.parseLocal('2026-12-01', '11:00'), 3, now), null);
  assert.match(A.validateRentalRequest(T.parseLocal('2026-12-01', '10:00'), 3, now), /3 ชั่วโมง/);
});

test('return reminder: sent once, 3h before the deadline, only for confirmed orders not yet returned', async () => {
  const { setSettings } = require('../src/db');
  const now = Date.now();
  const dueIn = (o, ms) => db.prepare('UPDATE order_items SET due_at = ?, return_reminded_at = NULL WHERE order_id = ?').run(now + ms, o.id);

  const soon = makeOrder('confirmed'); dueIn(soon.order, 2 * 3600000);          // due in 2h → remind
  const later = makeOrder('confirmed'); dueIn(later.order, 5 * 3600000);        // due in 5h → not yet
  const returned = makeOrder('returned'); dueIn(returned.order, 3600000);       // already returned → no
  const overdue = makeOrder('confirmed'); dueIn(overdue.order, -3600000);       // past deadline → no

  sent.length = 0;
  await O.runReturnReminders(now);
  assert.deepEqual(sent.map((m) => m.to), [soon.userLineId]);
  const text = sent[0].messages[0].text;
  assert.match(text, /ใกล้ถึงกำหนดคืนชุด \(อีกประมาณ 2 ชม\.\)/);
  assert.match(text, /Rosé Dress \(ไซส์ M\) x1[\s\S]*คืนภายใน/);

  sent.length = 0;
  await O.runReturnReminders(now + 60000);
  assert.equal(sent.length, 0, 'not sent twice');

  await O.runReturnReminders(now + 2.5 * 3600000);  // later order now within 3h
  assert.deepEqual(sent.map((m) => m.to), [later.userLineId]);

  sent.length = 0;
  setSettings({ return_reminder_hours: '0' });
  const off = makeOrder('confirmed'); dueIn(off.order, 3600000);
  await O.runReturnReminders(now);
  assert.equal(sent.length, 0, '0 = off');
  setSettings({ return_reminder_hours: '3' });
});
