/*
 * Bilingual product search (Thai ⇄ English) for a shop whose product names are mostly English.
 * A customer can type "เดรสสีขาว ลายดอก" and still find "White Floral Dress".
 *
 * How it works:
 *   1. The query is cut into known terms (longest match first, works without spaces in Thai)
 *      and leftover words.
 *   2. Each known term expands to its whole synonym group (Thai + English spellings).
 *   3. A product matches when EVERY term matches its name or description (any synonym).
 *
 * To teach the search a new word, add it to a group below (or add a new group).
 * Keep Thai entries specific enough not to appear inside unrelated words
 * (e.g. use "ลายจุด", not "จุด"; "ผ้าไหม", not "ไหม").
 */
const GROUPS = [
  // ---- garments
  ['dress', 'เดรส', 'ชุดเดรส', 'เดรท'],
  ['maxi', 'แม็กซี่', 'แมกซี่', 'แม็คซี่', 'ยาวกรอมเท้า'],
  ['midi', 'มิดี้', 'มิดิ'],
  ['mini', 'มินิ', 'กระโปรงสั้น', 'เดรสสั้น'],
  ['gown', 'evening', 'ชุดราตรี', 'ราตรี', 'ชุดออกงานกลางคืน'],
  ['top', 'เสื้อ', 'ท็อป', 'ท๊อป'],
  ['crop', 'ครอป', 'ครอบ', 'เอวลอย'],
  ['shirt', 'เชิ้ต', 'เชิ้ร์ต', 'เสื้อเชิ้ต'],
  ['blouse', 'เบลาส์', 'เบล้าส์'],
  ['skirt', 'กระโปรง'],
  ['pants', 'trousers', 'กางเกง', 'กางเกงขายาว'],
  ['shorts', 'กางเกงขาสั้น', 'ขาสั้น'],
  ['jeans', 'denim', 'ยีนส์', 'ยีน', 'เดนิม'],
  ['jumpsuit', 'จั๊มสูท', 'จัมพ์สูท', 'จั้มสูท', 'จั๊มสูธ'],
  ['romper', 'playsuit', 'รอมเปอร์'],
  ['set', 'เซ็ต', 'เซท', 'ชุดเซ็ต', 'ชุดเซท', 'two piece', '2 piece', 'ทูพีซ'],
  ['suit', 'สูท'],
  ['blazer', 'เบลเซอร์', 'เบรเซอร์'],
  ['jacket', 'แจ็คเก็ต', 'แจ็กเก็ต', 'แจ๊คเก็ต'],
  ['coat', 'โค้ท', 'โค้ต', 'เสื้อโค้ท'],
  ['cardigan', 'คาร์ดิแกน', 'คาดิแกน'],
  ['vest', 'waistcoat', 'เสื้อกั๊ก', 'กั๊ก'],
  ['bodysuit', 'บอดี้สูท', 'บอดี้สูธ'],
  ['swimsuit', 'swimwear', 'bikini', 'ชุดว่ายน้ำ', 'บิกินี่', 'บิกินี'],
  ['corset', 'bustier', 'คอร์เซ็ท', 'คอร์เซ็ต', 'คอเซ็ท'],
  ['thai', 'ชุดไทย'],
  ['qipao', 'cheongsam', 'กี่เพ้า', 'กี่เผ้า'],
  ['kimono', 'yukata', 'กิโมโน', 'ยูกาตะ'],
  ['hanbok', 'ฮันบก'],
  // ---- cuts & details
  ['tube', 'strapless', 'เกาะอก'],
  ['off shoulder', 'off-shoulder', 'offshoulder', 'เปิดไหล่', 'ปาดไหล่', 'ปาดไหล'],
  ['one shoulder', 'one-shoulder', 'ไหล่เดียว'],
  ['halter', 'คล้องคอ', 'ผูกคอ'],
  ['cami', 'camisole', 'spaghetti', 'สายเดี่ยว'],
  ['sleeveless', 'แขนกุด'],
  ['long sleeve', 'long-sleeve', 'แขนยาว'],
  ['short sleeve', 'short-sleeve', 'แขนสั้น'],
  ['puff', 'แขนตุ๊กตา', 'แขนพอง'],
  ['backless', 'open back', 'โชว์หลัง', 'เปิดหลัง', 'แหวกหลัง'],
  ['slit', 'ผ่าข้าง', 'ผ่าหน้า', 'ผ่าขา'],
  ['ruffle', 'frill', 'ระบาย'],
  ['pleat', 'pleated', 'อัดพลีท', 'พลีท'],
  ['wrap', 'ผ้าป้าย', 'แบบป้าย'],
  ['bow', 'ribbon', 'โบว์', 'ริบบิ้น'],
  ['pearl', 'มุก', 'ไข่มุก'],
  ['sequin', 'glitter', 'เลื่อม', 'กลิตเตอร์'],
  ['bead', 'beaded', 'ปักมุก', 'ลูกปัด'],
  ['embroider', 'embroidery', 'embroidered', 'ปัก', 'งานปัก'],
  ['cut out', 'cutout', 'cut-out', 'เว้า', 'คัทเอาท์'],
  ['mesh', 'sheer', 'ซีทรู', 'see through', 'ผ้าตาข่าย'],
  // ---- fabrics
  ['lace', 'ลูกไม้'],
  ['tulle', 'ผ้าทูล', 'ทูล'],
  ['satin', 'ซาติน', 'ผ้าซาติน'],
  ['silk', 'ผ้าไหม', 'ซิลค์', 'ซิลก์'],
  ['velvet', 'กำมะหยี่'],
  ['knit', 'ไหมพรม', 'นิต', 'นิตติ้ง'],
  ['linen', 'ลินิน', 'ผ้าลินิน'],
  ['cotton', 'คอตตอน', 'ผ้าฝ้าย', 'ฝ้าย'],
  ['chiffon', 'ชีฟอง'],
  ['tweed', 'ทวีด'],
  ['leather', 'หนัง', 'เลเธอร์'],
  ['organza', 'ออแกนซ่า', 'ออร์แกนซ่า'],
  // ---- patterns
  ['floral', 'flower', 'flowers', 'ดอกไม้', 'ลายดอก', 'ลายดอกไม้', 'ดอก'],
  ['dot', 'polka', 'ลายจุด', 'จุดๆ'],
  ['stripe', 'striped', 'ลายทาง', 'ลายริ้ว', 'ริ้ว'],
  ['plaid', 'check', 'gingham', 'tartan', 'ลายสก็อต', 'สก็อต', 'สก๊อต', 'ลายตาราง'],
  ['leopard', 'animal print', 'ลายเสือ', 'ลายเสือดาว'],
  ['print', 'printed', 'ลายพิมพ์'],
  ['plain', 'solid', 'สีพื้น'],
  // ---- colours
  ['white', 'ขาว', 'สีขาว', 'ivory', 'off white', 'off-white', 'ออฟไวท์', 'blanc'],
  ['black', 'ดำ', 'สีดำ', 'noir'],
  ['cream', 'ครีม', 'สีครีม', 'งาช้าง'],
  ['red', 'แดง', 'สีแดง', 'rouge'],
  ['wine', 'burgundy', 'maroon', 'ไวน์', 'แดงเลือดหมู', 'เลือดหมู', 'เบอร์กันดี'],
  ['pink', 'ชมพู', 'สีชมพู'],
  ['rose', 'โรส', 'กุหลาบ'],
  ['blue', 'ฟ้า', 'สีฟ้า', 'น้ำเงิน', 'สีน้ำเงิน'],
  ['navy', 'กรมท่า', 'สีกรม', 'น้ำเงินเข้ม'],
  ['green', 'เขียว', 'สีเขียว'],
  ['sage', 'olive', 'เขียวมะกอก', 'มะกอก', 'เซจ'],
  ['mint', 'มิ้นท์', 'มิ้นต์', 'เขียวมิ้นท์'],
  ['yellow', 'เหลือง', 'สีเหลือง'],
  ['orange', 'ส้ม', 'สีส้ม'],
  ['purple', 'violet', 'ม่วง', 'สีม่วง'],
  ['lilac', 'lavender', 'ไลแลค', 'ลาเวนเดอร์', 'ม่วงอ่อน'],
  ['brown', 'coffee', 'mocha', 'chocolate', 'น้ำตาล', 'สีน้ำตาล', 'มอคค่า', 'ช็อกโกแลต'],
  ['beige', 'nude', 'tan', 'camel', 'เบจ', 'นู้ด', 'สีเนื้อ'],
  ['khaki', 'กากี'],
  ['grey', 'gray', 'เทา', 'สีเทา'],
  ['gold', 'golden', 'ทอง', 'สีทอง'],
  ['silver', 'สีเงิน', 'ซิลเวอร์'],
  ['champagne', 'แชมเปญ', 'แชมเปน'],
  ['pastel', 'พาสเทล'],
  // ---- occasions & styles
  ['wedding', 'bride', 'bridal', 'งานแต่ง', 'แต่งงาน', 'เจ้าสาว'],
  ['bridesmaid', 'เพื่อนเจ้าสาว'],
  ['party', 'ปาร์ตี้', 'งานเลี้ยง', 'ออกงาน'],
  ['graduation', 'รับปริญญา', 'ปริญญา'],
  ['prom', 'พรอม', 'งานพรอม'],
  ['beach', 'sea', 'ทะเล', 'ชายหาด'],
  ['casual', 'everyday', 'ใส่เล่น', 'ไปเที่ยว', 'คาเฟ่'],
  ['vintage', 'retro', 'วินเทจ', 'เรโทร'],
  ['korean', 'korea', 'เกาหลี'],
  ['chinese', 'จีน', 'ตรุษจีน'],
  ['christmas', 'xmas', 'คริสต์มาส'],
  ['cute', 'น่ารัก'],
  ['sexy', 'เซ็กซี่', 'เซ็กซี'],
  ['elegant', 'luxury', 'หรู', 'หรูหรา'],
  ['minimal', 'มินิมอล'],
];

/** Filler words that don't narrow the search ("ชุด", "สี" …). */
const STOP = new Set(['ชุด', 'สี', 'แบบ', 'ตัว', 'ที่', 'และ', 'กับ', 'หรือ', 'ลาย', 'ผ้า', 'ใส่', 'อยากได้', 'หา', 'the', 'a', 'an', 'and', 'or', 'with', 'of']);

const THAI_FILLER = ['ชุด', 'สี', 'แบบ', 'ลาย', 'ผ้า', 'ตัว', 'ใส่', 'หา', 'ที่', 'อยากได้', 'น่ารักๆ', 'สวยๆ', 'สวย', 'ๆ'];
/** "ชุดสี" → "", "แบบสวยๆ" → "" — Thai has no spaces, so filler words stick to the leftovers */
function stripThaiFiller(w) {
  let prev;
  do {
    prev = w;
    for (const f of THAI_FILLER) {
      if (w.startsWith(f)) w = w.slice(f.length);
      if (w.endsWith(f)) w = w.slice(0, -f.length);
    }
  } while (w && w !== prev);
  return w;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFC').trim();
const TERM_TO_GROUP = new Map();
GROUPS.forEach((g, i) => g.forEach((t) => TERM_TO_GROUP.set(norm(t), i)));
// longest first so "กางเกงขาสั้น" wins over "กางเกง", "น้ำเงินเข้ม" over "น้ำเงิน"
const TERMS = [...TERM_TO_GROUP.keys()].sort((a, b) => b.length - a.length);

/**
 * Split a query into search terms.
 * @returns {{ groups: string[][], literals: string[] }} groups = synonym lists from the dictionary,
 *          literals = other words searched as typed.
 */
function parse(query) {
  let rest = ` ${norm(query).replace(/[,;/|+]+/g, ' ')} `;
  const groupIdx = [];
  for (const t of TERMS) {
    if (!t) continue;
    // English words must match whole words; Thai terms can sit anywhere (Thai has no spaces)
    const isLatin = /^[a-z0-9 \-]+$/.test(t);
    const re = isLatin ? new RegExp(`(^|[^a-z0-9])${t.replace(/[-]/g, '\\-')}(?=[^a-z0-9]|$)`, 'g') : null;
    const hit = isLatin ? re.test(rest) : rest.includes(t);
    if (!hit) continue;
    const g = TERM_TO_GROUP.get(t);
    if (!groupIdx.includes(g)) groupIdx.push(g);
    rest = isLatin ? rest.replace(new RegExp(`(^|[^a-z0-9])${t.replace(/[-]/g, '\\-')}(?=[^a-z0-9]|$)`, 'g'), '$1 ') : rest.split(t).join(' ');
  }
  const literals = rest.split(/\s+/).map((w) => stripThaiFiller(w.replace(/^[-'"]+|[-'"]+$/g, ''))).filter((w) => w && !STOP.has(w) && !(w.length < 2 && /^[a-z0-9]$/.test(w)));
  return { groups: groupIdx.map((i) => GROUPS[i]), literals };
}

/**
 * SQL for "every term matches name or description".
 * @param {string} query
 * @param {object} params named-parameter object to fill
 * @param {{ literals?: boolean }} opts literals:false drops words not in the dictionary (fallback search)
 * @returns {{ sql: string|null, terms: number, literals: number }}
 */
function sqlFor(query, params, { literals = true } = {}) {
  const parsed = parse(query);
  const clauses = []; let n = 0;
  const like = (word) => { const k = `sq${n++}`; params[k] = `%${word.replace(/[%_]/g, '')}%`; return `(p.name LIKE @${k} OR p.description LIKE @${k})`; };
  for (const g of parsed.groups) clauses.push(`(${g.map(like).join(' OR ')})`);
  if (literals) for (const w of parsed.literals) clauses.push(like(w));
  return { sql: clauses.length ? clauses.join(' AND ') : null, terms: parsed.groups.length, literals: parsed.literals.length };
}

module.exports = { GROUPS, parse, sqlFor };
