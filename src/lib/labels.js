'use strict';

const ORDER_STATUS = {
  awaiting_payment: { th: 'รอชำระเงิน', en: 'Awaiting Payment', tone: 'warn' },
  pending_approval: { th: 'รอแอดมินตรวจสอบ', en: 'Pending Admin Approval', tone: 'info' },
  confirmed: { th: 'ยืนยันแล้ว', en: 'Confirmed', tone: 'ok' },
  returned: { th: 'คืนชุดแล้ว (ตรวจสอบ/ทำความสะอาด)', en: 'Returned', tone: 'info' },
  completed: { th: 'เสร็จสิ้น', en: 'Completed', tone: 'muted' },
  rejected: { th: 'ถูกปฏิเสธ', en: 'Rejected', tone: 'bad' },
  cancelled: { th: 'ยกเลิก', en: 'Cancelled', tone: 'bad' },
  expired: { th: 'หมดเวลาชำระเงิน', en: 'Expired', tone: 'muted' },
};

const PAYMENT_STATUS = {
  unpaid: { th: 'ยังไม่ชำระ', tone: 'warn' },
  submitted: { th: 'ส่งสลิปแล้ว รอตรวจสอบ', tone: 'info' },
  approved: { th: 'ชำระเงินสำเร็จ', tone: 'ok' },
  rejected: { th: 'สลิปไม่ผ่าน', tone: 'bad' },
  cancelled: { th: 'คำสั่งซื้อถูกยกเลิก การชำระเงินไม่สำเร็จ', tone: 'bad' },
};

const SHIPPING_STATUS = {
  preparing: { th: 'กำลังเตรียมจัดส่ง', en: 'Preparing Shipment' },
  shipped: { th: 'จัดส่งแล้ว', en: 'Shipped' },
  in_transit: { th: 'อยู่ระหว่างขนส่ง', en: 'In Transit' },
  delivered: { th: 'ส่งถึงแล้ว', en: 'Delivered' },
};
const SHIPPING_ORDER = ['preparing', 'shipped', 'in_transit', 'delivered'];

// parcel carriers (outbound shipping and customer returns); 'อื่น ๆ' lets the user type a name
const CARRIERS = ['ไปรษณีย์ไทย EMS', 'Flash Express', 'Kerry Express', 'J&T Express'];
const CARRIER_OTHER = 'อื่น ๆ';

const RETURN_METHOD = {
  parcel: 'ส่งพัสดุ',
  express: 'ส่งด่วน (Grab / Lalamove)',
};
// provinces where customers must return by express delivery only
const EXPRESS_ONLY_RETURN_PROVINCES = ['กรุงเทพมหานคร'];

const SHIPPING_METHOD = {
  ems: 'ส่งพัสดุ (EMS, Flash, Kerry, J&T หรืออื่น ๆ)',  // key kept as 'ems' for existing data
  express: 'Express Delivery (Grab / Lalamove)',
};

const BLOCK_REASON = {
  cleaning: 'ทำความสะอาด',
  repair: 'ซ่อมแซม',
  maintenance: 'ตรวจสอบสภาพ',
  offline: 'จองนอกระบบ / หน้าร้าน',
  unavailable: 'ปิดให้เช่าชั่วคราว',
};

const PROVINCES = ['กรุงเทพมหานคร', 'กระบี่', 'กาญจนบุรี', 'กาฬสินธุ์', 'กำแพงเพชร', 'ขอนแก่น', 'จันทบุรี', 'ฉะเชิงเทรา', 'ชลบุรี', 'ชัยนาท', 'ชัยภูมิ', 'ชุมพร', 'เชียงราย', 'เชียงใหม่', 'ตรัง', 'ตราด', 'ตาก', 'นครนายก', 'นครปฐม', 'นครพนม', 'นครราชสีมา', 'นครศรีธรรมราช', 'นครสวรรค์', 'นนทบุรี', 'นราธิวาส', 'น่าน', 'บึงกาฬ', 'บุรีรัมย์', 'ปทุมธานี', 'ประจวบคีรีขันธ์', 'ปราจีนบุรี', 'ปัตตานี', 'พระนครศรีอยุธยา', 'พะเยา', 'พังงา', 'พัทลุง', 'พิจิตร', 'พิษณุโลก', 'เพชรบุรี', 'เพชรบูรณ์', 'แพร่', 'ภูเก็ต', 'มหาสารคาม', 'มุกดาหาร', 'แม่ฮ่องสอน', 'ยโสธร', 'ยะลา', 'ร้อยเอ็ด', 'ระนอง', 'ระยอง', 'ราชบุรี', 'ลพบุรี', 'ลำปาง', 'ลำพูน', 'เลย', 'ศรีสะเกษ', 'สกลนคร', 'สงขลา', 'สตูล', 'สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร', 'สระแก้ว', 'สระบุรี', 'สิงห์บุรี', 'สุโขทัย', 'สุพรรณบุรี', 'สุราษฎร์ธานี', 'สุรินทร์', 'หนองคาย', 'หนองบัวลำภู', 'อ่างทอง', 'อำนาจเจริญ', 'อุดรธานี', 'อุตรดิตถ์', 'อุทัยธานี', 'อุบลราชธานี'];

const NOTIFICATION_TYPE = {
  booking_confirmed: 'ยืนยันการจอง',
  shipped: 'แจ้งจัดส่ง',
  slip_rejected: 'ขอสลิปใหม่',
  order_rejected: 'ปฏิเสธคำสั่งจอง',
  order_cancelled: 'ยกเลิกคำสั่งซื้อ',
  return_reminder: 'เตือนก่อนครบกำหนดคืน',
  admin_return_submitted: 'แจ้งแอดมิน: ลูกค้าส่งคืน',
  admin_slip_uploaded: 'แจ้งแอดมิน: สลิปรอตรวจ',
};

module.exports = { CARRIERS, CARRIER_OTHER, RETURN_METHOD, EXPRESS_ONLY_RETURN_PROVINCES, NOTIFICATION_TYPE, ORDER_STATUS, PAYMENT_STATUS, SHIPPING_STATUS, SHIPPING_ORDER, SHIPPING_METHOD, BLOCK_REASON, PROVINCES };
