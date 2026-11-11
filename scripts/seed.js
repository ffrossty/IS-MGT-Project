'use strict';
/* Seed sample products (size + B/W/H/L measurements) and illustrated placeholder images.
   Usage: npm run seed            (only when there are no products yet)
          npm run seed -- --force (add sample products anyway)                */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { db, setSettings } = require('../src/db');

const force = process.argv.includes('--force');
if (!force && db.prepare('SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL').get().n > 0) {
  console.log('Products already exist — skipping (use --force to add samples anyway).');
  process.exit(0);
}

const SHAPES = {
  gown: 'M128 70c4 14 14 22 22 22s18-8 22-22l18 8-8 70c-2 18 6 40 22 80l44 118H32l44-118c16-40 24-62 22-80l-8-70z',
  midi: 'M126 74c4 12 14 20 24 20s20-8 24-20l20 8-10 56 6 20c10 30 34 70 50 128H56c16-58 40-98 50-128l6-20-10-56z',
  mini: 'M128 80c4 12 12 18 22 18s18-6 22-18l22 8-10 58 4 16c8 26 22 54 32 92H80c10-38 24-66 32-92l4-16-10-58z',
  suit: 'M110 70l40 26 40-26 34 14 10 120-22 4-6-70-6 230h-34l-16-180-16 180h-34l-6-230-6 70-22-4 10-120z',
  thai: 'M132 72c4 10 10 16 18 16s14-6 18-16l26 10-14 30-20 4 4 30c8 50 22 120 28 200H96c6-80 20-150 28-200l4-30-20-4-14-30z',
};
function svg(shape, c1, c2, fill, accent) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${fill}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
<rect width="300" height="400" fill="url(#g)"/><circle cx="240" cy="70" r="90" fill="#fff" opacity=".18"/>
<line x1="150" y1="18" x2="150" y2="62" stroke="#3a342d" stroke-width="2" opacity=".5"/><path d="M134 66c0-10 7-16 16-16s16 6 16 16" fill="none" stroke="#3a342d" stroke-width="2.5" opacity=".55"/>
<path d="${SHAPES[shape]}" fill="url(#d)"/><path d="${SHAPES[shape]}" fill="none" stroke="#000" stroke-opacity=".08" stroke-width="2"/>
<ellipse cx="150" cy="392" rx="120" ry="6" fill="#000" opacity=".06"/></svg>`;
}

const chart = 'Size, อก (นิ้ว), เอว (นิ้ว), สะโพก (นิ้ว), ความยาว (นิ้ว)\nXS, 30-31, 24-25, 33-34, 54\nS, 32-33, 26-27, 35-36, 55\nM, 34-35, 28-29, 37-38, 56\nL, 36-37, 30-31, 39-40, 57\nXL, 38-39, 32-33, 41-42, 58';
const P = [
  { name: 'Celeste Satin Gown', cat: 'ชุดราตรี', price: 2500, extra: 400, shape: 'gown', colors: ['#e9e4ef', '#d9d1e4', '#8f84b8', '#5e5491'], sizes: [['Free size', 1]],
    desc: 'ชุดราตรียาวผ้าซาตินเนื้อหนา ทิ้งตัวสวย คอวีลึกพอดี แผ่นหลังเปิด เหมาะกับงานกาล่าและงานแต่งงานช่วงค่ำ\nผ้า: Silk satin · ซับใน · ซิปซ่อนด้านหลัง', size_chart: 'Size, อก (นิ้ว), เอว (นิ้ว), สะโพก (นิ้ว), ความยาว (นิ้ว)\nFree size, 32-35, 25-28, 35-38, 60' },
  { name: 'Rosé Tulle Midi Dress', cat: 'ชุดออกงาน', price: 1290, extra: 250, shape: 'midi', colors: ['#f6e7e4', '#efd6d1', '#e3a7a0', '#c7766f'], sizes: [['S', 2], ['M', 3], ['L', 1]],
    desc: 'เดรสผ้าทูลเล่ซ้อนชั้นสีชมพูกุหลาบ ช่วงอกจับจีบ เอวพอดี กระโปรงบานยาวคลุมเข่า ใส่ได้ทั้งงานเช้าและงานเย็น' },
  { name: 'Noir Tailored Suit Set', cat: 'สูท & เซ็ต', price: 1590, extra: 300, shape: 'suit', colors: ['#e7e5e1', '#d4d0c9', '#3b3a3a', '#1c1b1b'], sizes: [['S', 1], ['M', 2], ['L', 2], ['XL', 1]],
    desc: 'สูทเซ็ตสีดำทรงเข้ารูป เสื้อสูทกระดุมเดี่ยว + กางเกงขายาวทรงตรง เหมาะกับงานพิธีการและงานรับปริญญา' },
  { name: 'Sabai Silk Thai Dress', cat: 'ชุดไทย', price: 1890, extra: 350, shape: 'thai', colors: ['#f4ead6', '#ead9b8', '#c99a3e', '#8f6421'], sizes: [['S', 1], ['M', 1], ['L', 1]],
    desc: 'ชุดไทยจักรีผ้าไหมสีทองประยุกต์ สไบปักลายละเอียด ผ้าถุงหน้านางพร้อมใส่ เหมาะกับงานหมั้น งานแต่ง และงานพิธีไทย' },
  { name: 'Ivory Lace Bridesmaid', cat: 'ชุดเพื่อนเจ้าสาว', price: 990, extra: 200, shape: 'midi', colors: ['#f7f3ec', '#ece5d9', '#f3eee4', '#d6cbb8'], sizes: [['XS', 2], ['S', 3], ['M', 3], ['L', 2]],
    desc: 'เดรสลูกไม้สีงาช้างสำหรับเพื่อนเจ้าสาว มีหลายไซส์ จองเป็นทีมได้ ผ้าลูกไม้นิ่มไม่คัน ซับในเต็มตัว' },
  { name: 'Emerald Velvet Slip', cat: 'ชุดออกงาน', price: 1190, extra: 250, shape: 'gown', colors: ['#e3ece7', '#cfdfd6', '#2f7a5c', '#1b4d39'], sizes: [['S', 1], ['M', 1]],
    desc: 'สลิปเดรสผ้ากำมะหยี่สีเขียวมรกต สายเดี่ยวปรับได้ ผ่าข้างเล็กน้อย ดูหรูหราในทุกแสง' },
  { name: 'Pearl Mini Party Dress', cat: 'ชุดออกงาน', price: 890, extra: 150, shape: 'mini', colors: ['#eef0f3', '#dde2e9', '#fbfbfd', '#c7ced9'], sizes: [['S', 2], ['M', 2]],
    desc: 'มินิเดรสปักมุกทั้งตัว แขนพอง เหมาะกับปาร์ตี้ วันเกิด และงานเลี้ยงสังสรรค์' },
  { name: 'Champagne Sequin Gown', cat: 'ชุดราตรี', price: 2900, extra: 450, shape: 'gown', colors: ['#f3ece2', '#e7dbc9', '#d9bf94', '#a98656'], sizes: [['M', 1], ['L', 1]],
    desc: 'ชุดราตรีเลื่อมสีแชมเปญเต็มตัว ประกายระยิบระยับ ทรงเมอร์เมด เหมาะกับงานประกวดและงานเลี้ยงสำคัญ' },
];

const now = Date.now();
db.transaction(() => {
  P.forEach((p, idx) => {
    // one stock line per dress: size from the first sample size (Freesize/XS…XL), measurements per size
    const SZ = { 'Free size': 'Freesize', XS: 'XS', S: 'S', M: 'M', L: 'L', XL: 'XL' };
    const MEAS = { Freesize: [32, 35, 25, 28, null, null, 60], XS: [30, 31, 24, 25, 33, 34, 54], S: [32, 33, 26, 27, 35, 36, 55], M: [34, 35, 28, 29, 37, 38, 56], L: [36, 37, 30, 31, 39, 40, 57], XL: [38, 39, 32, 33, 41, 42, 58] };
    const size = SZ[p.sizes[0][0]] || null; const m = MEAS[size] || MEAS.M;
    const qty = p.sizes.reduce((t, [, q]) => t + q, 0);
    const tiers = JSON.stringify([{ days: 1, price: Math.round(p.price * 0.6 / 10) * 10 }, { days: 3, price: p.price }, { days: 5, price: p.price + 2 * p.extra }]);
    const id = db.prepare(`INSERT INTO products(name, description, conditions, size, bust, bust_max, waist, waist_max, hip, hip_max, hip_free, length,
        base_price, base_days, extra_day_price, price_tiers, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`).run(p.name, p.desc, 'ค่ามัดจำชุด 1,000 บาท คืนเต็มจำนวนเมื่อส่งคืนชุดตามกำหนดและชุดอยู่ในสภาพดี',
      size, m[0], m[1], m[2], m[3], m[4], m[5], m[4] == null ? 1 : 0, m[6], Math.round(p.price * 0.6 / 10) * 10, p.extra, tiers, now - idx * 60000, now).lastInsertRowid;
    const addSku = (label, q, mm, sort) => db.prepare(`INSERT INTO skus(product_id, size_label, stock_qty, sort, bust, bust_max, waist, waist_max, hip, hip_max, hip_free, length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, label, q, sort, mm[0], mm[1], mm[2], mm[3], mm[4], mm[5], mm[4] == null ? 1 : 0, mm[6]);
    if (p.sizes.length > 1 && size) {
      // sample dress with several sizes — each size has its own measurements and stock
      p.sizes.forEach(([lab, q], i) => { const sz = SZ[lab] || lab; addSku(sz, q, MEAS[sz] || MEAS.M, i); });
    } else addSku(size || '', qty, m, 0);
    const [c1, c2, f, a] = p.colors;
    const variants = [[c1, c2, f, a], [c2, c1, a, f], ['#f1ede7', c1, f, a]];
    variants.forEach((v, i) => {
      const file = `sample-${id}-${i}.svg`;
      fs.writeFileSync(path.join(config.uploadDir, 'products', file), svg(p.shape, ...v));
      db.prepare('INSERT INTO product_images(product_id, filename, sort) VALUES (?, ?, ?)').run(id, file, i);
    });
  });
})();
setSettings({ express_origin: 'สยามสแควร์ กรุงเทพฯ' });
console.log(`Seeded ${P.length} sample products.`);
