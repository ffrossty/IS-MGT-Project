'use strict';
// PromptPay (Thai QR Payment / EMVCo) payload generator — produces a QR that banking apps
// open with the exact amount pre-filled. No external API needed.

function tlv(id, value) { return id + String(value.length).padStart(2, '0') + value; }

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normalizeTarget(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return { tag: '01', value: ('0066' + digits.slice(1)) }; // mobile
  if (digits.length === 13) return { tag: '02', value: digits };                                           // national ID / tax ID
  if (digits.length === 15) return { tag: '03', value: digits };                                           // e-wallet
  return null;
}

function payload(promptpayId, amount) {
  const t = normalizeTarget(promptpayId);
  if (!t) throw new Error('PromptPay ID ต้องเป็นเบอร์มือถือ 10 หลัก, เลขประจำตัว 13 หลัก หรือ e-Wallet 15 หลัก');
  const merchant = tlv('00', 'A000000677010111') + tlv(t.tag, t.value);
  let p = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('29', merchant) + tlv('58', 'TH') + tlv('53', '764');
  if (amount) p += tlv('54', Number(amount).toFixed(2));
  p += '6304';
  return p + crc16(p);
}

module.exports = { payload, crc16, normalizeTarget };
