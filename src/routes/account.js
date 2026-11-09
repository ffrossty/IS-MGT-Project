'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { db, getSettings } = require('../db');
const O = require('../lib/orders');
const promptpay = require('../lib/promptpay');
const { imageUploader, verifyImages } = require('../lib/upload');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
const slipUpload = imageUploader('slips', { maxMb: 8 });

function ownOrder(req, res, next) {
  const o = O.getOrderByCode(req.params.code);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'ไม่พบคำสั่งซื้อ', message: 'ไม่พบคำสั่งซื้อนี้ในบัญชีของคุณ', status: 404 });
  }
  req.order = o;
  next();
}

router.get('/account', requireLogin, (req, res) => {
  res.render('account/profile', { title: 'บัญชีของฉัน' });
});

router.get('/orders', requireLogin, (req, res) => {
  const orders = db.prepare(`SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count,
      (SELECT MIN(start_at) FROM order_items WHERE order_id = o.id) AS first_start
    FROM orders o WHERE user_id = ? ORDER BY id DESC`).all(req.user.id);
  res.render('account/orders', { title: 'คำสั่งจองของฉัน', orders });
});

router.get('/orders/:code', requireLogin, ownOrder, (req, res) => {
  const items = O.getItems(req.order.id);
  const events = db.prepare("SELECT * FROM order_events WHERE order_id = ? AND type NOT IN ('note','review_overdue') ORDER BY id").all(req.order.id);
  res.render('account/order', { title: `คำสั่งซื้อ ${req.order.code}`, o: req.order, items, events });
});

router.get('/orders/:code/pay', requireLogin, ownOrder, (req, res) => {
  if (req.order.status !== 'awaiting_payment') return res.redirect(`/orders/${req.order.code}`);
  const items = O.getItems(req.order.id);
  const s = getSettings();
  res.render('account/pay', { title: 'ชำระเงิน', o: req.order, items, hasPromptPay: !!promptpay.normalizeTarget(s.promptpay_id), qrImage: s.payment_qr_image });
});

router.get('/orders/:code/qr.png', requireLogin, ownOrder, async (req, res) => {
  const s = getSettings();
  if (!promptpay.normalizeTarget(s.promptpay_id)) return res.status(404).end();
  const png = await QRCode.toBuffer(promptpay.payload(s.promptpay_id, req.order.total), { width: 520, margin: 1, errorCorrectionLevel: 'M' });
  res.set('Cache-Control', 'private, no-store').type('png').send(png);
});

router.post('/orders/:code/slip', requireLogin, ownOrder, slipUpload.single('slip'), (req, res) => {
  const [file] = verifyImages(req.file ? [req.file] : []);
  if (!file) { res.flash('error', 'กรุณาอัปโหลดรูปสลิปการโอนเงิน (JPG/PNG)'); return res.redirect(`/orders/${req.order.code}/pay`); }
  try {
    O.uploadSlip(req.order, req.user, file.filename);
  } catch (e) {
    fs.rmSync(file.path, { force: true });
    throw e;
  }
  res.flash('success', 'ส่งสลิปเรียบร้อย ระบบล็อกสต็อกไว้ให้แล้ว กรุณารอแอดมินตรวจสอบ');
  res.redirect(`/orders/${req.order.code}`);
});

router.get('/orders/:code/return', requireLogin, ownOrder, (req, res) => {
  if (req.order.status !== 'confirmed') { res.flash('info', 'คำสั่งซื้อนี้ไม่อยู่ในสถานะที่ต้องส่งคืน'); return res.redirect(`/orders/${req.order.code}`); }
  res.render('account/return', { title: 'ส่งคืนชุด', o: req.order, items: O.getItems(req.order.id), methods: O.returnMethodsFor(req.order), form: req.order });
});

router.post('/orders/:code/return', requireLogin, ownOrder, async (req, res, next) => {
  try {
    await O.submitReturn(req.order, req.user, { method: req.body.return_method, tracking: req.body.return_tracking, note: req.body.return_note });
    res.flash('success', 'แจ้งส่งคืนชุดเรียบร้อย ร้านจะตรวจรับและแจ้งสถานะให้ทราบ');
    res.redirect(`/orders/${req.order.code}`);
  } catch (e) { next(e); }
});

router.post('/orders/:code/cancel', requireLogin, ownOrder, async (req, res, next) => {
  try { await O.cancel(req.order, req.user, 'ลูกค้ายกเลิกเอง'); } catch (e) { return next(e); }
  res.flash('success', 'ยกเลิกคำสั่งจองแล้ว');
  res.redirect(`/orders/${req.order.code}`);
});

// Payment slips are private: only the owner or an admin may view them.
router.get('/slips/:file', requireLogin, (req, res) => {
  const file = path.basename(req.params.file);
  const o = db.prepare('SELECT user_id FROM orders WHERE slip_filename = ?').get(file)
    || db.prepare("SELECT o.user_id FROM order_events e JOIN orders o ON o.id = e.order_id WHERE e.type = 'slip_uploaded' AND e.data LIKE ?").get(`%"${file}"%`);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(config.uploadDir, 'slips', file));
});

module.exports = router;
