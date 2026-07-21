// routes/invoicePdf.js
const express  = require('express');
const router   = express.Router();
const { get, all } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { generateInvoicePdf, generateThermalPdf } = require('../utils/invoicePdf');

router.use(authenticate);

async function getInvoiceFullData(id) {
  const invoice = await get(`
    SELECT inv.*, c.name as customer_name, c.code as customer_code,
           c.type as customer_type, c.phone as customer_phone,
           c.address as customer_address, c.tax_number as customer_tax,
           l.name as location_name
    FROM invoices inv
    JOIN customers c ON inv.customer_id=c.id
    LEFT JOIN locations l ON inv.location_id=l.id
    WHERE inv.id=?`, [id]);
  if (!invoice) return null;
  const items    = await all(`SELECT ii.*, p.name as product_name, p.sku, p.unit FROM invoice_items ii JOIN products p ON ii.product_id=p.id WHERE ii.invoice_id=?`,[id]);
  const payments = await all(`SELECT * FROM customer_payments WHERE invoice_id=? ORDER BY payment_date`,[id]);
  const installs = await all(`SELECT * FROM customer_installments WHERE invoice_id=? ORDER BY installment_number`,[id]);
  return { invoice, items, payments, installments: installs };
}

// GET /api/invoices/:id/pdf  — A4
router.get('/:id/pdf', async (req, res) => {
  const data = await getInvoiceFullData(req.params.id);
  if (!data) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${data.invoice.invoice_number}.pdf"`);
  generateInvoicePdf(data, res);
});

// GET /api/invoices/:id/thermal — 80mm thermal
router.get('/:id/thermal', async (req, res) => {
  const data = await getInvoiceFullData(req.params.id);
  if (!data) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${data.invoice.invoice_number}-thermal.pdf"`);
  generateThermalPdf(data, res);
});

// GET /api/invoices/:id/whatsapp — رابط مشاركة واتساب
router.get('/:id/whatsapp', async (req, res) => {
  const data = await getInvoiceFullData(req.params.id);
  if (!data) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

  const { invoice, items } = data;
  const bal = (invoice.total||0) - (invoice.paid_amount||0);

  // بناء رسالة WhatsApp نصية احترافية
  const lines = [
    `🏮 *نجف وإضاءة — فاتورة مبيعات*`,
    `━━━━━━━━━━━━━━━━━━`,
    `📋 رقم الفاتورة: *${invoice.invoice_number}*`,
    `📅 التاريخ: ${invoice.invoice_date}`,
    invoice.due_date ? `⏰ الاستحقاق: ${invoice.due_date}` : null,
    `━━━━━━━━━━━━━━━━━━`,
    `👤 العميل: *${invoice.customer_name}*`,
    `━━━━━━━━━━━━━━━━━━`,
    `📦 *البنود:*`,
    ...items.map((item, i) =>
      `${i+1}. ${item.product_name}\n   ${item.quantity} × ${Number(item.unit_price).toLocaleString('ar-EG')} = *${Number(item.line_total).toLocaleString('ar-EG')} ج*`
    ),
    `━━━━━━━━━━━━━━━━━━`,
    invoice.discount_amount > 0 ? `🏷️ خصم: ${Number(invoice.discount_amount).toLocaleString('ar-EG')} ج` : null,
    `💰 *الإجمالي: ${Number(invoice.total).toLocaleString('ar-EG')} ج*`,
    invoice.paid_amount > 0 ? `✅ المدفوع: ${Number(invoice.paid_amount).toLocaleString('ar-EG')} ج` : null,
    bal > 0.01 ? `⚠️ *المتبقي: ${Number(bal).toLocaleString('ar-EG')} ج*` : `✅ *مدفوعة بالكامل*`,
    `━━━━━━━━━━━━━━━━━━`,
    `🙏 شكراً لتعاملكم معنا`,
  ].filter(Boolean).join('\n');

  const phone = req.query.phone || invoice.customer_phone || '';
  const encodedMsg = encodeURIComponent(lines);
  const whatsappUrl = phone
    ? `https://wa.me/${phone.replace(/\D/g,'')}?text=${encodedMsg}`
    : `https://wa.me/?text=${encodedMsg}`;

  res.json({ url: whatsappUrl, message: lines });
});

module.exports = router;
