'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbFile = process.env.DB_FILE || path.join(config.dataDir, 'rental.db');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// All timestamps are stored as INTEGER epoch milliseconds (UTC).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  picture_url TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  is_friend INTEGER,
  phone TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  size_chart TEXT NOT NULL DEFAULT '',
  base_price INTEGER NOT NULL DEFAULT 0,       -- THB for base_days
  base_days INTEGER NOT NULL DEFAULT 3,
  extra_day_price INTEGER NOT NULL DEFAULT 0,  -- THB per additional day
  buffer_before_hours INTEGER,                 -- NULL = use global setting
  buffer_after_hours INTEGER,                  -- NULL = use global setting
  is_active INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_label TEXT NOT NULL,
  stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_skus_product_size ON skus(product_id, size_label) WHERE deleted_at IS NULL;

-- Units unavailable for a period: cleaning, repair, offline reservation, etc.
CREATE TABLE IF NOT EXISTS sku_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT 'maintenance',
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS ix_blocks_sku ON sku_blocks(sku_id, start_at, end_at);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL CHECK (qty > 0),
  start_at INTEGER NOT NULL,
  days INTEGER NOT NULL CHECK (days > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  subtotal INTEGER NOT NULL,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  shipping_method TEXT NOT NULL CHECK (shipping_method IN ('ems','express')),
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT NOT NULL,
  subdistrict TEXT NOT NULL,
  postcode TEXT NOT NULL,
  customer_note TEXT,
  hold_expires_at INTEGER,
  review_due_at INTEGER,
  review_overdue INTEGER NOT NULL DEFAULT 0,
  slip_filename TEXT,
  slip_uploaded_at INTEGER,
  reject_reason TEXT,
  shipping_status TEXT,
  tracking_number TEXT,
  express_provider TEXT,
  express_info TEXT,
  shipped_at INTEGER,
  delivered_at INTEGER,
  shipping_note TEXT,
  confirmed_at INTEGER,
  returned_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  size_label TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  start_at INTEGER NOT NULL,
  days INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  block_start INTEGER NOT NULL,  -- start_at - buffer_before (stock occupied from)
  block_end INTEGER NOT NULL,    -- due_at + buffer_after (stock occupied until)
  unit_price INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_sku ON order_items(sku_id, block_start, block_end);
CREATE INDEX IF NOT EXISTS ix_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,           -- sent | failed | skipped
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_sync (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  row_number INTEGER,
  dirty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | synced | failed | not_configured
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

db.exec(SCHEMA);

// ---- lightweight migrations (add columns introduced after the first release)
function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addColumn('order_items', 'return_reminded_at', 'INTEGER');   // return-deadline reminder already sent
addColumn('orders', 'return_method', 'TEXT');          // customer's return shipment: ems | express
addColumn('orders', 'return_tracking', 'TEXT');        // tracking number / link given by the customer
addColumn('orders', 'return_note', 'TEXT');
addColumn('orders', 'return_submitted_at', 'INTEGER');
addColumn('orders', 'return_carrier', 'TEXT');         // parcel company chosen by the customer for the return
addColumn('orders', 'shipping_carrier', 'TEXT');       // parcel company the shop used to ship
addColumn('products', 'price_tiers', 'TEXT');          // JSON [{days, price}] — price table by rental length
addColumn('products', 'promo_type', 'TEXT');           // percent | amount | NULL
addColumn('products', 'promo_value', 'INTEGER');
addColumn('products', 'promo_start', 'INTEGER');
addColumn('products', 'promo_end', 'INTEGER');
addColumn('products', 'promo_label', 'TEXT');
addColumn('order_items', 'list_price', 'INTEGER');
// สัดส่วนชุด (นิ้ว) — ใช้แทนระบบไซส์ และใช้กรองในหน้าคอลเลกชัน
addColumn('products', 'bust', 'REAL');
addColumn('products', 'waist', 'REAL');
addColumn('products', 'hip', 'REAL');
addColumn('products', 'length', 'REAL');
addColumn('products', 'bust_max', 'REAL');      // ถ้ามีค่า = สัดส่วนเป็นช่วง (bust … bust_max) เช่น ผ้ายืด 32–36
addColumn('products', 'waist_max', 'REAL');
addColumn('products', 'hip_max', 'REAL');
addColumn('products', 'length_max', 'REAL');
addColumn('products', 'bust_free', 'INTEGER NOT NULL DEFAULT 0');    // 1 = Freesize สำหรับสัดส่วนนั้น
addColumn('products', 'waist_free', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'hip_free', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'length_free', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'size', 'TEXT');                             // Freesize | XS | S | M | L | XL | NULL (ไม่ระบุ)     // price before promotion (for records)
db.prepare("UPDATE orders SET return_method = 'parcel', return_carrier = COALESCE(return_carrier, 'ไปรษณีย์ไทย EMS') WHERE return_method = 'ems'").run();

const DEFAULT_SETTINGS = {
  shop_name: 'GMD Rental',
  shop_tagline: 'Fashion rental · เช่าชุดออกงาน',
  shop_phone: '',
  shop_line_url: '',
  express_origin: 'กรุงเทพฯ (ระบุเขต/จุดรับในหน้าตั้งค่า)',
  ems_fee: '80',
  promptpay_id: '',
  promptpay_name: '',
  payment_qr_image: '',
  payment_hold_minutes: '60',      // time to pay & upload slip
  slip_reupload_minutes: '60',     // time to upload a new slip after admin rejects one
  notify_admin_slip: '1',          // LINE admins when a customer uploads a slip
  admin_review_hours: '24',        // target time for admin to verify slip
  auto_expire_unreviewed: '0',     // 1 = release stock if admin doesn't review in time
  buffer_before_hours: '0',        // prepare/ship before rental start
  buffer_after_hours: '48',        // inspection + cleaning after the return deadline (express returns)
  parcel_extra_hours: '72',        // extra hours added when the order uses parcel shipping (slower return transit)
  pickup_start_hour: '9',          // earliest allowed rental start/return time
  pickup_end_hour: '18',
  min_advance_hours: '3',          // booking must start at least this far ahead
  return_reminder_hours: '3',      // LINE the customer this long before the return deadline (0 = off)
  return_name: 'GMD Rental',       // where customers send the clothes back
  return_phone: '',
  return_address: '',
  notify_admin_return: '1',        // LINE admins when a customer submits return shipping info
  shop_promo_type: '',             // shop-wide promotion: percent | amount | ''
  shop_promo_value: '',
  shop_promo_start: '',            // epoch ms ('' = no limit)
  shop_promo_end: '',
  shop_promo_label: '',
  max_advance_days: '180',
  duration_options: '1,2,3,4,5,7',
  rental_terms: 'ลูกค้าต้องส่งคืนชุดภายในวันและเวลาที่กำหนด หากคืนล่าช้ามีค่าปรับตามเงื่อนไขของร้าน\nห้ามซักหรือรีดชุดเอง ร้านเป็นผู้ทำความสะอาด\nกรณีชุดเสียหายหรือสูญหาย ร้านจะประเมินค่าเสียหายตามจริง',
  google_sheet_url: '',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// one-time rename of the original placeholder shop name
db.prepare("UPDATE settings SET value = 'GMD Rental' WHERE key = 'shop_name' AND value = 'Maison Lumière'").run();

// one-time: orders cancelled before the 'cancelled' payment status existed
{
  const ids = db.prepare("SELECT id FROM orders WHERE status = 'cancelled' AND payment_status NOT IN ('approved','cancelled')").all();
  if (ids.length) {
    db.transaction(() => {
      for (const { id } of ids) {
        db.prepare("UPDATE orders SET payment_status = 'cancelled' WHERE id = ?").run(id);
        db.prepare("INSERT INTO sheet_sync(order_id, dirty, status) VALUES (?, 1, 'pending') ON CONFLICT(order_id) DO UPDATE SET dirty = 1").run(id);
      }
    })();
  }
}

// one-time: dresses are bookable again right after cleaning (no extra prep time) — old untouched default 24h → 0
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_prep_0'").get()) {
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'buffer_before_hours' AND value = '24'").run();
  db.prepare("INSERT INTO settings(key, value) VALUES ('migr_prep_0', '1')").run();
}

// one-time: move the old 48h advance-booking default to 3h (an admin-chosen value other than 48 is kept)
// ระบบไซส์ใหม่: 1 ชุด = 1 สต็อก มีไซส์ (ไม่บังคับ) จาก Freesize, XS, S, M, L, XL
// สินค้าเดิมที่มีสต็อกชุดเดียว: ย้ายชื่อไซส์ไปไว้ที่ products.size (ถ้าตรงกับรายการ) ไม่งั้นเว้นว่าง
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_size_v2'").get()) {
  const norm = (v) => { const k = String(v || '').toLowerCase().replace(/[\s_-]+/g, ''); return { freesize: 'Freesize', fs: 'Freesize', f: 'Freesize', xs: 'XS', s: 'S', m: 'M', l: 'L', xl: 'XL' }[k] || null; };
  const singles = db.prepare(`SELECT s.id, s.product_id, s.size_label FROM skus s WHERE s.deleted_at IS NULL AND s.product_id IN
    (SELECT product_id FROM skus WHERE deleted_at IS NULL GROUP BY product_id HAVING COUNT(*) = 1)`).all();
  db.transaction(() => {
    for (const s of singles) {
      const size = norm(s.size_label);
      db.prepare('UPDATE products SET size = COALESCE(size, ?) WHERE id = ?').run(size, s.product_id);
      db.prepare('UPDATE skus SET size_label = ? WHERE id = ?').run(size || '', s.id);
    }
    db.prepare("INSERT INTO settings(key, value) VALUES ('migr_size_v2', '1')").run();
  })();
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migr_min_adv_3'").get()) {
  db.prepare("UPDATE settings SET value = '3' WHERE key = 'min_advance_hours' AND value = '48'").run();
  db.prepare("INSERT INTO settings(key, value) VALUES ('migr_min_adv_3', '1')").run();
}

const settingsCache = { data: null };
function getSettings() {
  if (!settingsCache.data) {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    settingsCache.data = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  return settingsCache.data;
}
function setSettings(obj) {
  const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(obj)) up.run(k, String(v ?? '')); })();
  settingsCache.data = null;
}
function num(key, def = 0) {
  const v = Number(getSettings()[key]);
  return Number.isFinite(v) ? v : def;
}

module.exports = { db, dbFile, getSettings, setSettings, settingNum: num, DEFAULT_SETTINGS };
