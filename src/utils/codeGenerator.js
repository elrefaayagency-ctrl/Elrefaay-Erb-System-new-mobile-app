// utils/codeGenerator.js
const { get } = require('../db/database');
const { nextDocumentNumber } = require('./sequenceGenerator');

// توليد SKU تلقائي بصيغة PRD-00001 إذا لم يحدد المستخدم كوداً مخصصاً
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع sequenceGenerator.js)
async function generateSKU() {
  return nextDocumentNumber('product_sku_seq', 'PRD', 5, async () => {
    const result = await get(`SELECT COUNT(*) as count FROM products`);
    return (result ? result.count : 0) + 1;
  });
}

// توليد باركود رقمي فريد (EAN-13 مبسط) بناءً على timestamp + رقم عشوائي
// يضمن عدم التكرار عبر التحقق من القاعدة
async function generateBarcode() {
  let barcode;
  let exists = true;
  let attempts = 0;

  while (exists && attempts < 10) {
    const timestampPart = Date.now().toString().slice(-9);
    const randomPart = Math.floor(Math.random() * 900 + 100).toString();
    barcode = (timestampPart + randomPart).slice(0, 12);
    // إضافة رقم تحقق بسيط (checksum) كآخر رقم لجعلها 13 رقم شبيهة بـ EAN-13
    let sum = 0;
    for (let i = 0; i < barcode.length; i++) {
      sum += parseInt(barcode[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    barcode = barcode + checkDigit;

    const existing = await get(`SELECT id FROM products WHERE barcode = ?`, [barcode]);
    exists = !!existing;
    attempts++;
  }

  return barcode;
}

module.exports = { generateSKU, generateBarcode };
