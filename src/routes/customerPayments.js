// routes/customerPayments.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction }               = require('../utils/auditLog');
const eventBus = require('../utils/eventBus');
const { round2 } = require('../utils/money');
const { computeInstallmentApplication, allocatePaymentFIFO } = require('../utils/installmentEngine');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genPaymentNumber() {
  return nextDocumentNumber('customer_payment_number_seq', 'RCP', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM customer_payments`);
    return (r?.c || 0) + 1;
  });
}

// GET /api/customer-payments
router.get('/', async (req, res) => {
  const { customer_id, invoice_id, from_date, to_date } = req.query;
  let sql = `
    SELECT cp.*, c.name as customer_name, inv.invoice_number, u.full_name as created_by
    FROM customer_payments cp
    JOIN customers c ON cp.customer_id=c.id
    LEFT JOIN invoices inv ON cp.invoice_id=inv.id
    LEFT JOIN users u ON cp.user_id=u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND cp.customer_id=?`; params.push(customer_id); }
  if (invoice_id)  { sql += ` AND cp.invoice_id=?`;  params.push(invoice_id); }
  if (from_date)   { sql += ` AND cp.payment_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND cp.payment_date<=?`; params.push(to_date); }
  sql += ` ORDER BY cp.payment_date DESC LIMIT 300`;
  res.json({ payments: await all(sql, params) });
});

// POST /api/customer-payments
// نفس مشكلة supplierPayments.js بالظبط (راجع الشرح المفصّل هناك): التحقق من
// "المتبقي على الفاتورة" والتحديث كانا بيعتمدوا على قيمة مقروءة قبل الـ
// transaction ومحسوبة في الكود، وده مش آمن تحت التزامن. تم إصلاحه بنفس الطريقة:
// قفل صف الفاتورة (FOR UPDATE) جوه المعاملة + تحديث ذرّي مباشر في قاعدة البيانات.
router.post('/', authorize('admin','manager','sales'), async (req, res) => {
  const { customer_id, invoice_id, amount, payment_method, payment_date,
          reference, notes, installment_id } = req.body;

  if (!customer_id || !amount || amount <= 0)
    return res.status(400).json({ error: 'العميل والمبلغ مطلوبان' });

  if (!await get(`SELECT id FROM customers WHERE id=?`,[customer_id]))
    return res.status(404).json({ error: 'العميل غير موجود' });

  const paymentAmount = round2(amount);

  let payId;
  try {
    payId = await transaction(async () => {
      let targetInvoice = null;
      if (invoice_id) {
        targetInvoice = await get(`SELECT * FROM invoices WHERE id=? FOR UPDATE`,[invoice_id]);
        if (!targetInvoice) { const e = new Error('الفاتورة غير موجودة'); e.status = 404; throw e; }
        const remaining = round2(targetInvoice.total - targetInvoice.paid_amount);
        if (paymentAmount > remaining + 0.01) {
          const e = new Error(`المبلغ المدخل (${paymentAmount.toFixed(2)}) أكبر من المتبقي على الفاتورة (${remaining.toFixed(2)}) — تأكد من المبلغ`);
          e.status = 400;
          throw e;
        }
      }

      const payNumber = await genPaymentNumber();
      const id = await insert(`
        INSERT INTO customer_payments
        (payment_number,customer_id,invoice_id,amount,payment_method,payment_date,reference,notes,user_id)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [payNumber, customer_id, invoice_id||null, paymentAmount,
         payment_method||'cash',
         payment_date||new Date().toISOString().split('T')[0],
         reference||null, notes||null, req.user.id]
      );

      // تحديث paid_amount والحالة في الفاتورة — بصيغة ذرّية، وبقراءة الحالة الفعلية
      // *بعد* التحديث (مش بحساب مسبق في الكود) لضمان الاتساق تحت التزامن
      if (targetInvoice) {
        await run(`UPDATE invoices SET paid_amount = paid_amount + ?, updated_at=datetime('now') WHERE id=?`,
          [paymentAmount, invoice_id]);
        const updatedInv = await get(`SELECT paid_amount, total, status FROM invoices WHERE id=?`,[invoice_id]);
        const newStatus = updatedInv.paid_amount >= updatedInv.total ? 'paid'
                        : updatedInv.paid_amount > 0        ? 'partial'
                        : updatedInv.status;
        await run(`UPDATE invoices SET status=? WHERE id=?`,[newStatus, invoice_id]);
      }

      // ── تخصيص الدفعة على الأقساط — بمنطق موحّد للحالتين ──
      // (المراجعة المالية): سابقاً كان فيه فرق سلوك حسب طريقة الدفع — لو
      // العميل دفع من خلال "تسديد قسط محدد" وزاد عن قيمته، كان الطلب
      // *يُرفض بالكامل*؛ ولو دفع من غير تحديد قسط، كان الفائض يتوزّع صح.
      // ده مش السلوك الصحيح احترافياً: أي نظام تحصيل أقساط (زي أنظمة
      // البنوك وشركات التقسيط) بيسوّي الأقدم استحقاقاً أولاً دايماً — لو
      // العميل دفع 2000 ج.م والقسط المستهدف قيمته 1000، الـ 1000 الزيادة
      // المفروض تتحول تلقائياً للقسط التالي (وهكذا)، مش تترفض العملية كلها.
      // فبقى المصدر الوحيد لتوزيع أي دفعة مرتبطة بخطة تقسيط هو نفس محرك
      // الـ FIFO، بغض النظر هل حُدِّد قسط بعينه في الطلب ولا لأ.
      if (targetInvoice && targetInvoice.payment_type === 'installment') {
        const pendingInstallments = await all(
          `SELECT * FROM customer_installments WHERE invoice_id=? AND status IN ('pending','overdue','partial') FOR UPDATE`,
          [invoice_id]
        );
        const { allocations } = allocatePaymentFIFO(pendingInstallments, paymentAmount);
        for (const a of allocations) {
          await run(`UPDATE customer_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
            [a.newPaid, a.newStatus, id, a.id]);
        }
      } else if (installment_id) {
        // قسط محدد على مستند مش خطة تقسيط رسمية (نادر، لأغراض توافق قديمة) —
        // لسه بنطبّق نفس حد الأمان (مايتجاوزش متبقي القسط نفسه)
        const inst = await get(`SELECT * FROM customer_installments WHERE id=? FOR UPDATE`,[installment_id]);
        if (inst) {
          const application = computeInstallmentApplication(inst, paymentAmount);
          if (application.error) { const e = new Error(application.error); e.status = 400; throw e; }
          await run(`UPDATE customer_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
            [application.newPaid, application.newStatus, id, installment_id]);
        }
      }

      return id;
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  await logAction(req.user.id,'create','customer_payment',payId,{ customer_id, amount, invoice_id });

  const paymentForMsg = await get(`SELECT * FROM customer_payments WHERE id=?`,[payId]);
  const customerForMsg = await get(`SELECT * FROM customers WHERE id=?`,[customer_id]);
  const invoiceForMsg = invoice_id ? await get(`SELECT * FROM invoices WHERE id=?`,[invoice_id]) : null;
  eventBus.emit('customer_payment.recorded', { payment: paymentForMsg, customer: customerForMsg, invoice: invoiceForMsg, actorName: req.user.full_name });

  res.status(201).json({ message:'تم تسجيل الدفعة بنجاح', payment: paymentForMsg });
});

// DELETE /api/customer-payments/:id (إلغاء تحصيل — admin فقط)
router.delete('/:id', authorize('admin'), async (req, res) => {
  const pay = await get(`SELECT * FROM customer_payments WHERE id=?`,[req.params.id]);
  if (!pay) return res.status(404).json({ error: 'الدفعة غير موجودة' });

  await transaction(async () => {
    if (pay.invoice_id) {
      await run(`UPDATE invoices SET paid_amount=MAX(0,ROUND(paid_amount-?,2)), updated_at=datetime('now') WHERE id=?`,[pay.amount, pay.invoice_id]);
      const inv = await get(`SELECT * FROM invoices WHERE id=?`,[pay.invoice_id]);
      if (inv) {
        const status = inv.paid_amount <= 0 ? 'confirmed' : inv.paid_amount < inv.total ? 'partial' : 'paid';
        await run(`UPDATE invoices SET status=? WHERE id=?`,[status, pay.invoice_id]);
      }
    }
    await run(`UPDATE customer_installments SET paid_amount=MAX(0,ROUND(paid_amount-?,2)), status='pending', payment_id=NULL WHERE payment_id=?`,
      [pay.amount, pay.id]);
    await run(`DELETE FROM customer_payments WHERE id=?`,[req.params.id]);
  });

  await logAction(req.user.id,'delete','customer_payment',req.params.id,null);
  res.json({ message:'تم إلغاء الدفعة بنجاح' });
});

module.exports = router;