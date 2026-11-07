# Clothing Rental E-commerce & Booking Management System

ระบบเว็บไซต์ให้เช่าชุด แบ่งเป็น **Customer Website** (หน้าร้าน) และ **Admin Dashboard** (หลังบ้าน) ใช้ฐานข้อมูลของระบบเอง (SQLite) เป็นแหล่งข้อมูลหลัก
ทำงานได้จริงทั้งระบบ: เช็กวันว่างตามสต็อกจริง, ตะกร้าหลายรายการ, ล็อกสต็อกชั่วคราว, กันการจองซ้อน, QR PromptPay, อัปโหลดสลิป, แอดมินตรวจสลิป, จัดส่ง, LINE Notification, Google Sheets, Backup และ Audit log

---

## 1. เริ่มต้นใช้งาน (Local)

ต้องมี **Node.js 18.17 ขึ้นไป** (แนะนำ 20 หรือ 22)

```bash
npm install
cp .env.example .env        # แล้วแก้ค่าใน .env
npm run seed                # (ไม่บังคับ) ใส่สินค้าตัวอย่าง 8 รายการ
npm start                   # เปิด http://localhost:3000
npm test                    # รัน unit + end-to-end tests
```

ก่อนตั้งค่า LINE ยังทดสอบระบบได้ด้วย **Dev Login** (หน้า /login → "Dev Login") ซึ่งเลือกบทบาท Customer หรือ Admin ได้
Dev Login เป็นทางเข้าทดสอบเท่านั้น **ไม่ใช่ LINE Login** และจะปิดเองเมื่อ `NODE_ENV=production`

---

## 2. ค่าที่ต้องตั้งค่าเพิ่มเติม (Credentials)

ระบบ **ไม่จำลองว่าเชื่อมต่อสำเร็จ** ถ้ายังไม่ได้ตั้งค่า จะแสดงสถานะ "ยังไม่ได้ตั้งค่า" ที่หน้า Admin › การเชื่อมต่อ และบันทึกการแจ้งเตือนเป็น `skipped`

| ฟังก์ชัน | ตัวแปรใน `.env` | ได้มาจาก |
|---|---|---|
| LINE Login | `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET` | LINE Developers › Provider › **LINE Login channel** › Basic settings |
| Callback URL | (ใช้ `BASE_URL`) | ลงทะเบียน `{BASE_URL}/auth/line/callback` ในแท็บ LINE Login ของ channel |
| LINE OA แจ้งเตือน | `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`, `LINE_OA_BASIC_ID` | LINE Developers › **Messaging API channel** › Channel access token (long-lived) |
| Admin | `ADMIN_LINE_USER_IDS` | LINE userId (ขึ้นต้นด้วย `U…`) ดูได้ที่หน้า /account หลัง Login |
| Google Sheets | `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (หรือ `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`) | Google Cloud Console › Service Account |
| QR ชำระเงิน | ตั้งในหน้า Admin › ตั้งค่าร้าน (PromptPay ID หรืออัปโหลดรูป QR) | — |

### 2.1 LINE Login + LINE OA
1. สร้าง **Provider** ใน https://developers.line.biz/console/
2. ใน Provider เดียวกัน สร้าง **LINE Login channel** และ **Messaging API channel** (ต้องอยู่ Provider เดียวกัน เพื่อให้ userId ของ LINE Login ตรงกับ userId ที่ OA ส่งข้อความได้)
3. ใน LINE Login channel: ตั้ง Callback URL = `{BASE_URL}/auth/line/callback`, เปิด scope `openid` และ `profile`, ไปที่ **Linked LINE Official Account** แล้วเลือก OA ของร้าน (ระบบส่ง `bot_prompt=aggressive` เพื่อชวนลูกค้าเพิ่มเพื่อนตอน Login)
4. ใน Messaging API channel: ออก **Channel access token (long-lived)** ใส่ใน `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN`
5. Login ด้วย LINE หนึ่งครั้ง ดู userId ที่ /account แล้วใส่ใน `ADMIN_LINE_USER_IDS` (หรือรัน `npm run make-admin -- Uxxxxxxxx`) แล้วรีสตาร์ต
6. ทดสอบที่ Admin › การเชื่อมต่อ › "ส่งข้อความทดสอบถึง LINE ของฉัน"

> ข้อจำกัดของ LINE: ลูกค้าต้องเป็นเพื่อนกับ OA จึงจะได้รับ Push message และ LINE Login ต้องใช้ HTTPS ในการใช้งานจริง (localhost ใช้ทดสอบได้) ข้อความแบบ Push นับรวมในโควตาข้อความรายเดือนของแพ็กเกจ OA

ระบบส่ง LINE เพียง 2 เหตุการณ์: **ยืนยันการจอง** (Order ID, ชุด, วันเริ่ม/กำหนดคืน) และ **จัดส่งแล้ว** (วิธีจัดส่ง, Tracking, ลิงก์ติดตามสถานะ)

### 2.2 Google Sheets
1. Google Cloud Console › สร้าง Project › เปิดใช้ **Google Sheets API**
2. สร้าง **Service Account** › Keys › Add key (JSON)
3. สร้าง Google Sheet แล้ว **Share** ให้อีเมล Service Account เป็น Editor
4. ใส่ Spreadsheet ID (ส่วนกลางของ URL `/d/<ID>/edit`) และ key ลง `.env`

ระบบจะสร้างแท็บ `Orders` + หัวตารางอัตโนมัติ เขียน **1 แถวต่อ 1 Order ID** (ค้นหาแถวจาก Order ID ก่อนเขียนทุกครั้ง จึงไม่เกิดข้อมูลซ้ำ) และอัปเดตทุกครั้งที่สถานะเปลี่ยน
การซิงก์ทำผ่านคิว (`sheet_sync`) ถ้า Google ล่ม การจองยังทำงานปกติ และระบบจะลองใหม่ทุก 1 นาที กดปุ่ม "เปิด Google Sheets" ได้จากเมนู Admin

---

## 3. หลักการทำงานที่สำคัญ

### การคำนวณระยะเวลาเช่า (นับเป็นชั่วโมง)
`กำหนดคืน = เวลาเริ่ม + (จำนวนวัน × 24 ชม.)` เช่น เริ่ม 9 พ.ย. 09:00 + 3 วัน → คืนภายใน 12 พ.ย. 09:00 (72 ชม.)
ทุกเวลาใช้ Asia/Bangkok และเก็บใน DB เป็น epoch ms (UTC)

### สต็อกตามช่วงเวลา (SKU = สินค้า + ไซส์)
แต่ละการจองล็อกชุดในช่วง
`[เวลาเริ่ม − เวลาเตรียมชุด, กำหนดคืน + เวลาตรวจสอบ/ทำความสะอาด)`
(ตั้งค่าเริ่มต้นได้ที่ตั้งค่าร้าน และกำหนดแยกต่อสินค้าได้)
จำนวนว่าง = สต็อก − **จำนวนสูงสุดที่ถูกใช้พร้อมกัน** ในช่วงนั้น (sweep-line) รวมถึงช่วงที่แอดมินปิดไว้ (ซัก/ซ่อม/จองนอกระบบ)

### การป้องกันการจองซ้อน (Double Booking)
ตอนส่งคำสั่งจอง ระบบตรวจสต็อกทุกรายการใหม่ และบันทึกใน transaction แบบ `BEGIN IMMEDIATE` (ล็อกการเขียนทั้งฐานข้อมูล) การตรวจและการล็อกสต็อกจึงเป็นขั้นตอนเดียวกัน ไม่มีช่องว่างให้คำสั่งจองอื่นแทรก รายการในตะกร้าที่เป็น SKU เดียวกันและเวลาทับกันจะถูกนับรวมกันด้วย

### สถานะคำสั่งซื้อ
```
awaiting_payment ──อัปโหลดสลิป──▶ pending_approval ──แอดมินยืนยัน──▶ confirmed ──รับคืน──▶ returned ──ทำความสะอาดเสร็จ──▶ completed
      │ หมดเวลา → expired               │ ขอสลิปใหม่ → awaiting_payment
      │ ยกเลิก → cancelled               │ ปฏิเสธ → rejected (คืนสต็อก)
```
- สถานะที่ล็อกสต็อก: `awaiting_payment` (จนหมดเวลา), `pending_approval`, `confirmed`, `returned`
- การอัปโหลดสลิป**ไม่ทำให้ชำระเงินสำเร็จอัตโนมัติ** ต้องให้แอดมินกดยืนยัน
- ลูกค้าไม่ชำระภายใน `payment_hold_minutes` → หมดอายุ คืนสต็อกอัตโนมัติ
- แอดมินไม่ตรวจภายใน `admin_review_hours` → ติดธง "เกินเวลาตรวจ" บน Dashboard (เลือกให้คืนสต็อกอัตโนมัติได้ในตั้งค่า)
- สถานะจัดส่ง: Preparing Shipment → Shipped → In Transit → Delivered (EMS ต้องมี Tracking ก่อนเป็น Shipped)

### ความปลอดภัย
- ตรวจสิทธิ์ Admin จากฐานข้อมูลทุกคำขอ ลูกค้าเข้า `/admin` ไม่ได้ (403)
- CSRF token ทุกฟอร์ม, session cookie แบบ httpOnly/SameSite (Secure เมื่อ production), เปลี่ยน session ID ตอน Login
- Helmet + Content-Security-Policy, SQL แบบ parameterized ทั้งหมด
- สลิปโอนเงินเก็บแบบ private (เปิดได้เฉพาะเจ้าของคำสั่งซื้อและแอดมิน) ตรวจไฟล์รูปจาก magic bytes
- Audit log บันทึกการแก้ไขสินค้า สต็อก สิทธิ์ ตั้งค่า และประวัติแต่ละคำสั่งซื้อ (order_events)

### Backup
สำรองฐานข้อมูลอัตโนมัติทุก 24 ชม. (`backups/`, เก็บตาม `BACKUP_KEEP`) หรือกดสำรองเองที่ Admin › การเชื่อมต่อ หรือ `npm run backup`
**ควรสำรองโฟลเดอร์ `uploads/` ด้วย** (รูปสินค้าและสลิป)

---

## 4. โครงสร้างโปรเจกต์

```
src/
  server.js            Express app, security, session
  config.js            อ่าน .env
  db.js                schema + settings
  lib/
    availability.js    คำนวณสต็อกว่างตามช่วงเวลา
    orders.js          จอง/ล็อกสต็อก/อนุมัติ/ปฏิเสธ/จัดส่ง/หมดเวลา
    time.js            เวลาไทย + คำนวณกำหนดคืน
    line.js            LINE Login + Messaging API
    sheets.js          Google Sheets sync queue
    promptpay.js       สร้าง QR PromptPay พร้อมยอดเงิน
    backup.js, jobs.js, upload.js, audit.js, session-store.js
  routes/  auth.js · shop.js · account.js · admin.js
views/     EJS templates (shop, account, admin)
public/    CSS / JS
scripts/   seed.js · backup.js · make-admin.js
test/      unit.test.js · e2e.test.js
```

## 5. Deploy (ใช้งานจริง)
- ใช้ server/VPS ที่มี disk ถาวร (เช่น VPS, Railway/Render + Persistent Disk) เพราะ SQLite และรูปเก็บเป็นไฟล์
- ตั้ง `NODE_ENV=production`, `BASE_URL=https://your-domain`, `SESSION_SECRET` ค่ายาวแบบสุ่ม และใช้ HTTPS (ผ่าน reverse proxy เช่น Nginx/Caddy)
- รันด้วย process manager เช่น `pm2 start src/server.js --name rental`
- ต้องการรองรับผู้ใช้จำนวนมาก/หลายเครื่อง: ย้ายไป PostgreSQL ได้ โดย logic การล็อกสต็อกอยู่ใน `lib/orders.js` และ `lib/availability.js` (ใช้ `SELECT … FOR UPDATE` บนแถว SKU แทน `BEGIN IMMEDIATE`)

## 6. สิ่งที่ยังไม่รวม / ต่อยอดได้
- ตรวจสลิปอัตโนมัติผ่าน API (เช่น บริการ Slip Verification) — ตอนนี้แอดมินตรวจเองตามโจทย์
- ฐานข้อมูลที่อยู่ไทยแบบ auto-complete เขต/แขวง (ตอนนี้เลือกจังหวัด + กรอกเขต/แขวงเอง พร้อมตรวจรหัสไปรษณีย์ 5 หลัก)
- ค่าปรับคืนล่าช้า/มัดจำแบบคำนวณอัตโนมัติ (ตอนนี้ระบุเป็นข้อความในเงื่อนไขการเช่า)
