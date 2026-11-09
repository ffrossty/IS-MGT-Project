'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-unit-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.DATA_DIR = tmp; process.env.UPLOAD_DIR = path.join(tmp, 'up'); process.env.BACKUP_DIR = path.join(tmp, 'bk');

const T = require('../src/lib/time');
const A = require('../src/lib/availability');
const promptpay = require('../src/lib/promptpay');
const { unitPrice } = require('../src/lib/pricing');

test('rental duration is hours-based: 9 Nov 09:00 + 3 days → 12 Nov 09:00 (72h)', () => {
  const start = T.parseLocal('2026-11-09', '09:00');
  const w = T.rentalWindow(start, 3, 24, 48);
  assert.equal(w.hours, 72);
  assert.equal(T.toInputDateTime(w.dueAt), '2026-11-12T09:00');
  assert.equal(T.toInputDateTime(w.blockStart), '2026-11-08T09:00');
  assert.equal(T.toInputDateTime(w.blockEnd), '2026-11-14T09:00');
  assert.equal(T.rentalWindow(start, 5).hours, 120);
});

test('parseLocal interprets input as Asia/Bangkok and rejects invalid dates', () => {
  assert.equal(new Date(T.parseLocal('2026-11-09', '09:00')).toISOString(), '2026-11-09T02:00:00.000Z');
  assert.equal(T.parseLocal('2026-02-31', '09:00'), null);
  assert.equal(T.parseLocal('garbage'), null);
});

test('maxConcurrent counts simultaneous usage, not the sum of all overlaps', () => {
  // two bookings back-to-back inside the window never overlap each other
  const list = [{ s: 0, e: 10, q: 1 }, { s: 10, e: 20, q: 1 }, { s: 5, e: 15, q: 2 }];
  assert.equal(A.maxConcurrent(list, 0, 20), 3);
  assert.equal(A.maxConcurrent([{ s: 0, e: 10, q: 1 }, { s: 10, e: 20, q: 1 }], 0, 20), 1);
  assert.equal(A.maxConcurrent([{ s: 0, e: 10, q: 1 }], 10, 20), 0);
});

test('pricing: base price covers base days, extra days charged', () => {
  const p = { base_price: 1500, base_days: 3, extra_day_price: 300 };
  assert.equal(unitPrice(p, 1), 1500);
  assert.equal(unitPrice(p, 3), 1500);
  assert.equal(unitPrice(p, 5), 2100);
});

test('PromptPay payload has valid structure and CRC', () => {
  const p = promptpay.payload('0812345678', 1290);
  assert.match(p, /^000201010212/);
  assert.ok(p.includes('01130066812345678'));
  assert.ok(p.includes('54071290.00'));
  assert.equal(promptpay.crc16(p.slice(0, -4)), p.slice(-4));
  // CRC-16/CCITT-FALSE standard check value
  assert.equal(promptpay.crc16('123456789'), '29B1');
  assert.throws(() => promptpay.payload('123'));
});
