'use strict';
/**
 * LINE Login (OAuth 2.1 / OpenID Connect) + LINE Messaging API (push message).
 * Docs: https://developers.line.biz/en/docs/line-login/integrate-line-login/
 *       https://developers.line.biz/en/reference/messaging-api/#send-push-message
 */
const crypto = require('crypto');
const config = require('../config');
const { db, getSettings } = require('../db');
const T = require('./time');

const AUTH_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const FRIENDSHIP_URL = 'https://api.line.me/friendship/v1/status';
const PUSH_URL = 'https://api.line.me/v2/bot/message/push';

const callbackUrl = () => `${config.baseUrl}/auth/line/callback`;

function buildAuthorizeUrl(session) {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  session.lineAuth = { state, nonce, at: Date.now() };
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.line.loginChannelId,
    redirect_uri: callbackUrl(),
    state,
    scope: 'profile openid',
    nonce,
    // asks the user to add the shop's LINE OA as a friend (needed for push notifications)
    bot_prompt: 'aggressive',
  });
  return `${AUTH_URL}?${q}`;
}

async function postForm(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LINE ${url} → ${res.status} ${json.error_description || json.error || json.message || ''}`);
  return json;
}

/** Exchange code → tokens, verify id_token, return profile { sub, name, picture, isFriend }. */
async function handleCallback(session, { code, state, error, error_description: errDesc }) {
  const saved = session.lineAuth;
  delete session.lineAuth;
  if (error) throw new Error(`LINE Login ถูกยกเลิก: ${errDesc || error}`);
  if (!saved || !state || saved.state !== state) throw new Error('state ไม่ถูกต้อง กรุณาลองเข้าสู่ระบบใหม่');
  if (Date.now() - saved.at > 10 * 60 * 1000) throw new Error('หมดเวลาเข้าสู่ระบบ กรุณาลองใหม่');
  const tokens = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code', code, redirect_uri: callbackUrl(),
    client_id: config.line.loginChannelId, client_secret: config.line.loginChannelSecret,
  });
  const idt = await postForm(VERIFY_URL, { id_token: tokens.id_token, client_id: config.line.loginChannelId, nonce: saved.nonce });
  let isFriend = null;
  try {
    const r = await fetch(FRIENDSHIP_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (r.ok) isFriend = (await r.json()).friendFlag ? 1 : 0;
  } catch (_) { /* optional */ }
  return { sub: idt.sub, name: idt.name || 'LINE User', picture: idt.picture || null, isFriend };
}

// ---------------- Messaging ----------------
const insNotif = db.prepare('INSERT INTO notifications(order_id, user_id, type, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)');

async function push(lineUserId, messages) {
  const res = await fetch(PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.line.messagingToken}`, 'X-Line-Retry-Key': crypto.randomUUID() },
    body: JSON.stringify({ to: lineUserId, messages }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`push ${res.status}: ${j.message || ''} ${j.details ? JSON.stringify(j.details) : ''}`.trim());
  }
}

async function notify(order, type, text, userId = order.user_id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const log = (status, err) => { insNotif.run(order.id, userId, type, status, err || null, Date.now()); return { status, error: err || null }; };
  if (!config.lineMessagingConfigured) return log('skipped', 'ยังไม่ได้ตั้งค่า LINE_MESSAGING_CHANNEL_ACCESS_TOKEN');
  if (!user || !user.line_user_id || user.line_user_id.startsWith('dev-')) return log('skipped', 'ผู้ใช้นี้ไม่ได้เข้าสู่ระบบด้วย LINE จริง (Dev Login)');
  try {
    await push(user.line_user_id, [{ type: 'text', text: text.slice(0, 4900) }]);
    return log('sent');
  } catch (e) {
    console.error('[line] notify failed', e.message);
    return log('failed', e.message);
  }
}

function itemLines(items) {
  return items.map((it) => `• ${it.product_name}${require('./view-helpers').sz(it.size_label, true)} x${it.qty}\n  เริ่ม ${T.dt(it.start_at)}\n  คืนภายใน ${T.dt(it.due_at)} (${it.days} วัน)`).join('\n');
}

function bookingConfirmed(order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const shop = getSettings().shop_name;
  const text = `✅ ${shop}: ยืนยันการจองแล้ว\nหมายเลขคำสั่งซื้อ: ${order.code}\n\n${itemLines(items)}\n\nยอดชำระ: ฿${order.total.toLocaleString('th-TH')}\nติดตามสถานะ: ${config.baseUrl}/orders/${order.code}`;
  return notify(order, 'booking_confirmed', text);
}

function shipped(order) {
  const method = order.shipping_method === 'ems' ? `ส่งพัสดุ${order.shipping_carrier ? ` (${order.shipping_carrier})` : ''}` : `Express Delivery${order.express_provider ? ` (${order.express_provider})` : ''}`;
  let text = `📦 ${getSettings().shop_name}: จัดส่งสินค้าแล้ว\nหมายเลขคำสั่งซื้อ: ${order.code}\nวิธีจัดส่ง: ${method}`;
  if (order.tracking_number) text += `\nTracking: ${order.tracking_number}`;
  const trackUrl = order.shipping_method === 'ems' ? require('./view-helpers').carrierTrackUrl(order.shipping_carrier, order.tracking_number) : null;
  if (trackUrl) text += `\nตรวจสอบพัสดุ: ${trackUrl}`;
  if (order.express_info) text += `\nรายละเอียด: ${order.express_info}`;
  if (order.shipping_note) text += `\nหมายเหตุ: ${order.shipping_note}`;
  text += `\n\nติดตามสถานะคำสั่งซื้อ: ${config.baseUrl}/orders/${order.code}`;
  return notify(order, 'shipped', text);
}

function itemsShort(order) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id)
    .map((it) => `• ${it.product_name}${require('./view-helpers').sz(it.size_label, true)} x${it.qty} — ${T.dt(it.start_at)}`).join('\n');
}

function slipRejected(order, reason) {
  const text = `⚠️ ${getSettings().shop_name}: สลิปการโอนเงินไม่ผ่านการตรวจสอบ\nหมายเลขคำสั่งซื้อ: ${order.code}\n\nเหตุผล: ${reason}\n\n`
    + `ยอดที่ต้องชำระ: ฿${order.total.toLocaleString('th-TH')}\nกรุณาอัปโหลดสลิปใหม่ภายใน ${T.dt(order.hold_expires_at)}\n`
    + `(ระบบยังล็อกชุดไว้ให้จนถึงเวลาดังกล่าว หากเกินเวลาคำสั่งจองจะถูกยกเลิกอัตโนมัติ)\n\nอัปโหลดสลิปใหม่: ${config.baseUrl}/orders/${order.code}/pay`;
  return notify(order, 'slip_rejected', text);
}

function orderRejected(order, reason) {
  const text = `❌ ${getSettings().shop_name}: คำสั่งจองถูกปฏิเสธ\nหมายเลขคำสั่งซื้อ: ${order.code}\n\n${itemsShort(order)}\n\nเหตุผล: ${reason}\n\n`
    + `หากมีข้อสงสัยหรือได้ชำระเงินแล้ว กรุณาติดต่อร้านผ่าน LINE นี้\nรายละเอียด: ${config.baseUrl}/orders/${order.code}`;
  return notify(order, 'order_rejected', text);
}

function orderCancelled(order, reason) {
  const paid = order.payment_status === 'approved';
  const text = `🚫 ${getSettings().shop_name}: คำสั่งซื้อถูกยกเลิก\nหมายเลขคำสั่งซื้อ: ${order.code}\n\n${itemsShort(order)}\n\nเหตุผล: ${reason}\n\n`
    + (paid ? 'ร้านจะติดต่อกลับเรื่องการคืนเงิน หรือติดต่อร้านผ่าน LINE นี้ได้เลย\n' : 'หากมีข้อสงสัย กรุณาติดต่อร้านผ่าน LINE นี้\n')
    + `รายละเอียด: ${config.baseUrl}/orders/${order.code}`;
  return notify(order, 'order_cancelled', text);
}

// ---------- Admin alerts (sent to every admin account that logged in with real LINE) ----------
async function notifyAdmins(order, type, text) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND line_user_id NOT LIKE 'dev-%'").all();
  return Promise.all(admins.map((a) => notify(order, type, text, a.id)));
}

function adminSlipUploaded(order) {
  if (getSettings().notify_admin_slip !== '1') return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const text = `💳 มีสลิปรอตรวจสอบ ${order.code}\nลูกค้า: ${order.recipient_name} · ${order.phone}\n\n${itemLines(items)}\n\nยอดที่ต้องได้รับ: ฿${order.total.toLocaleString('th-TH')}\n`
    + `ควรตรวจสอบภายใน ${T.dt(order.review_due_at)}\n\nตรวจสลิป: ${config.baseUrl}/admin/orders/${order.code}`;
  return notifyAdmins(order, 'admin_slip_uploaded', text);
}

function returnReminder(order, items, now = Date.now()) {
  const st = getSettings();
  const due = Math.min(...items.map((i) => i.due_at));
  const mins = Math.max(0, Math.round((due - now) / 60000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)} ชม.${mins % 60 ? ` ${mins % 60} นาที` : ''}` : `${mins} นาที`;
  const lines = items.map((i) => `• ${i.product_name}${require('./view-helpers').sz(i.size_label, true)} x${i.qty}\n  คืนภายใน ${T.dt(i.due_at)}`).join('\n');
  let text = `⏰ ${st.shop_name}: ใกล้ถึงกำหนดคืนชุด (อีกประมาณ ${left})\nหมายเลขคำสั่งซื้อ: ${order.code}\n\n${lines}\n\n`
    + 'กรุณาส่งคืนชุดภายในเวลาที่กำหนด หากคืนล่าช้าอาจมีค่าปรับตามเงื่อนไขของร้าน\n';
  if (st.shop_phone) text += `ติดต่อร้าน: ${st.shop_phone}\n`;
  text += `ส่งคืนแล้ว แจ้งเลขพัสดุ/ลิงก์ติดตามได้ที่: ${config.baseUrl}/orders/${order.code}/return`;
  return notify(order, 'return_reminder', text);
}

function adminReturnSubmitted(order, first = true) {
  if (getSettings().notify_admin_return !== '1') return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const L = require('./labels');
  const text = `📦↩️ ${first ? 'ลูกค้าแจ้งส่งคืนชุด' : 'ลูกค้าแก้ไขข้อมูลส่งคืน'} ${order.code}\nลูกค้า: ${order.recipient_name} · ${order.phone}\n\n`
    + items.map((i) => `• ${i.product_name}${require('./view-helpers').sz(i.size_label, true)} x${i.qty} — กำหนดคืน ${T.dt(i.due_at)}`).join('\n')
    + `\n\nวิธีส่งคืน: ${L.RETURN_METHOD[order.return_method] || order.return_method}${order.return_carrier ? ` (${order.return_carrier})` : ''}\nติดตาม: ${order.return_tracking}`
    + (order.return_note ? `\nหมายเหตุ: ${order.return_note}` : '')
    + `\n\nเมื่อได้รับชุดแล้ว กด "บันทึกรับคืนชุด": ${config.baseUrl}/admin/orders/${order.code}`;
  return notifyAdmins(order, 'admin_return_submitted', text);
}

module.exports = { adminReturnSubmitted, returnReminder, adminSlipUploaded, buildAuthorizeUrl, handleCallback, callbackUrl, bookingConfirmed, shipped, slipRejected, orderRejected, orderCancelled, push };
