// routes/settings.js — إعدادات الشركة (تُستخدم في الفواتير والطباعة وواتساب)
const express = require('express');
const router = express.Router();
const { get, run } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

// ── GET /api/settings — متاح لأي مستخدم مسجّل دخول (يحتاجه شريط النظام والطباعة) ──
router.get('/', async (req, res) => {
  const settings = await get(`SELECT * FROM settings WHERE id = 1`);
  res.json({ settings });
});

// ── PUT /api/settings — للمدراء فقط ──
router.put('/', authorize('admin', 'manager'), async (req, res) => {
  const current = await get(`SELECT * FROM settings WHERE id = 1`);
  const {
    company_name, company_name_en, slogan, address, phone, phone2,
    email, tax_number, commercial_register, invoice_footer_note, currency_symbol,
    notifications_enabled, installment_reminder_days, notify_low_stock,
  } = req.body;

  const finalName = company_name !== undefined ? company_name : current.company_name;
  if (!finalName || !finalName.trim())
    return res.status(400).json({ error: 'اسم الشركة مطلوب' });

  // نحافظ على أي حقل لم يُرسَل في الطلب بدل مسحه (تحديث جزئي آمن)
  const pick = (val, existing) => (val !== undefined ? (val || null) : existing);

  await run(
    `UPDATE settings SET
      company_name=?, company_name_en=?, slogan=?, address=?, phone=?, phone2=?,
      email=?, tax_number=?, commercial_register=?, invoice_footer_note=?,
      currency_symbol=?, notifications_enabled=?, installment_reminder_days=?, notify_low_stock=?,
      updated_at=datetime('now')
     WHERE id = 1`,
    [
      finalName.trim(),
      pick(company_name_en, current.company_name_en),
      pick(slogan, current.slogan),
      pick(address, current.address),
      pick(phone, current.phone),
      pick(phone2, current.phone2),
      pick(email, current.email),
      pick(tax_number, current.tax_number),
      pick(commercial_register, current.commercial_register),
      pick(invoice_footer_note, current.invoice_footer_note),
      currency_symbol !== undefined ? (currency_symbol || 'ج.م') : current.currency_symbol,
      notifications_enabled !== undefined ? (notifications_enabled ? 1 : 0) : current.notifications_enabled,
      installment_reminder_days !== undefined ? (parseInt(installment_reminder_days) || 1) : current.installment_reminder_days,
      notify_low_stock !== undefined ? (notify_low_stock ? 1 : 0) : current.notify_low_stock,
    ]
  );

  // نجمع أسماء الحقول اللي فعلاً اتغيّرت (مش مجرد أُرسلت) — عشان رسالة
  // التنبيه تبقى مفيدة ("اتغيّر كذا وكذا") مش قائمة كل الحقول المرسلة
  const fieldLabels = {
    company_name: 'اسم الشركة', address: 'العنوان', phone: 'الهاتف',
    notifications_enabled: 'تفعيل الإشعارات', installment_reminder_days: 'أيام تذكير الأقساط',
    notify_low_stock: 'تنبيه المخزون المنخفض', currency_symbol: 'رمز العملة',
  };
  const changedFields = Object.keys(fieldLabels).filter(k => req.body[k] !== undefined && req.body[k] != current[k]).map(k => fieldLabels[k]);

  await logAction(req.user.id, 'update', 'settings', 1, { company_name: finalName });
  const updatedSettings = await get(`SELECT * FROM settings WHERE id = 1`);
  if (changedFields.length) {
    eventBus.emit('settings.updated', { actorName: req.user.full_name, changedFields });
  }
  res.json({ message: 'تم حفظ إعدادات الشركة بنجاح', settings: updatedSettings });
});

module.exports = router;
