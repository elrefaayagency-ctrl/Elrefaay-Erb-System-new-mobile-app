// routes/supplierPayments.js
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { round2 }                             = require('../utils/money');
const { computeInstallmentApplication, allocatePaymentFIFO } = require('../utils/installmentEngine');
const { buildFileUrl }                       = require('../utils/fileUrl');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

// ===================== رفع إثبات الدفع (لطرق الدفع الإلكترونية) =====================
const uploadsDir = path.join(__dirname, '../uploads/payment_proofs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('صيغة الصورة غير مدعومة (JPEG, PNG, WEBP فقط)'));
  },
});

// طرق الدفع اللي محتاجة إثبات دفع إلزامي (كل حاجة إلكترونية غير النقدي)
const ELECTRONIC_METHODS = ['bank_transfer', 'cheque', 'vodafone_cash', 'instapay'];

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genPaymentNumber() {
  return nextDocumentNumber('supplier_payment_number_seq', 'PAY', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM supplier_payments`);
    return (r?.c || 0) + 1;
  });
}

// ── الدالة الأساسية لتسجيل دفعة مورد — مصدر الحقيقة الوحيد لتحديث رصيد
//    المورد وربط الأقساط، تُستخدم من راوت الدفعات المباشر وكمان من تسوية
//    أمر الشراء النقدي تلقائياً (purchaseOrders.js) بدل ما يتكرر المنطق ──
// ترجع { id } أو ترمي Error بـ .status لو فيه خطأ تحقق
async function createSupplierPayment({ supplier_id, po_id, amount, payment_method, payment_date, reference, notes, installment_id, proof_image_path, user_id }) {
  if (!supplier_id || !amount || amount <= 0) {
    const e = new Error('المورد والمبلغ مطلوبان'); e.status = 400; throw e;
  }
  if (!await get(`SELECT id FROM suppliers WHERE id=?`, [supplier_id])) {
    const e = new Error('المورد غير موجود'); e.status = 404; throw e;
  }

  const method = payment_method || 'cash';
  if (ELECTRONIC_METHODS.includes(method) && !proof_image_path) {
    const e = new Error('طريقة الدفع المختارة إلكترونية — يجب رفع صورة إثبات الدفع');
    e.status = 400; throw e;
  }

  const paymentAmount = round2(amount);

  return transaction(async () => {
    // ── قفل صف أمر الشراء (لو محدد) قبل أي قراءة/تحقق — يمنع أي طلب تاني
    //    يلمس نفس الصف لحد ما المعاملة دي تخلص كاملة (راجع الشرح الكامل
    //    لمشكلة التزامن دي في تعليق أقدم بأسفل الملف) ──
    let targetPO = null;
    if (po_id) {
      targetPO = await get(`SELECT * FROM purchase_orders WHERE id=? FOR UPDATE`, [po_id]);
      if (!targetPO) { const e = new Error('أمر الشراء غير موجود'); e.status = 404; throw e; }
      if (targetPO.status === 'cancelled') { const e = new Error('لا يمكن تسجيل دفعة على أمر شراء ملغى'); e.status = 400; throw e; }
      const remaining = round2(targetPO.total - targetPO.paid_amount);
      if (paymentAmount > remaining + 0.01) {
        const e = new Error(`المبلغ المدخل (${paymentAmount.toFixed(2)}) أكبر من المتبقي على أمر الشراء (${remaining.toFixed(2)}) — تأكد من المبلغ`);
        e.status = 400; throw e;
      }
    }

    const payNumber = await genPaymentNumber();
    const id = await insert(`
      INSERT INTO supplier_payments
      (payment_number,supplier_id,po_id,amount,payment_method,payment_date,reference,notes,proof_image_path,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [payNumber, supplier_id, po_id || null, paymentAmount,
       method,
       payment_date || new Date().toISOString().split('T')[0],
       reference || null, notes || null, proof_image_path || null, user_id]);

    // تحديث paid_amount في أمر الشراء بصيغة ذرّية (زيادة مباشرة في قاعدة البيانات)
    if (targetPO) {
      await run(`UPDATE purchase_orders SET paid_amount = paid_amount + ?, updated_at=datetime('now') WHERE id=?`,
        [paymentAmount, po_id]);
    }

    // ── تخصيص الدفعة على أقساط المورد — نفس منطق الجانب العميل بالضبط
    //    (المراجعة المالية): FIFO دايماً لأي مستند تقسيط، بغض النظر هل
    //    اتحدد قسط بعينه في الطلب. أي زيادة عن قيمة القسط المستهدف بتتحول
    //    تلقائياً للقسط التالي بدل ما العملية كلها تترفض. ──
    if (targetPO && targetPO.purchase_type === 'installment') {
      const pendingInstallments = await all(
        `SELECT * FROM payment_installments WHERE po_id=? AND status IN ('pending','overdue','partial') FOR UPDATE`,
        [po_id]
      );
      const { allocations } = allocatePaymentFIFO(pendingInstallments, paymentAmount);
      for (const a of allocations) {
        await run(`UPDATE payment_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
          [a.newPaid, a.newStatus, id, a.id]);
      }
    } else if (installment_id) {
      // قسط محدد على مستند مش خطة تقسيط رسمية (نادر، لأغراض توافق قديمة)
      const inst = await get(`SELECT * FROM payment_installments WHERE id=? FOR UPDATE`, [installment_id]);
      if (inst) {
        const application = computeInstallmentApplication(inst, paymentAmount);
        if (application.error) { const e = new Error(application.error); e.status = 400; throw e; }
        await run(`UPDATE payment_installments SET paid_amount=?, status=?, payment_id=?, updated_at=datetime('now') WHERE id=?`,
          [application.newPaid, application.newStatus, id, installment_id]);
      }
    }

    return { id };
  });
}

// ── GET /api/supplier-payments ──
router.get('/', async (req, res) => {
  const { supplier_id, po_id, from_date, to_date } = req.query;
  let sql = `
    SELECT sp.*, s.name as supplier_name, po.po_number, u.full_name as created_by
    FROM supplier_payments sp
    JOIN suppliers s ON sp.supplier_id = s.id
    LEFT JOIN purchase_orders po ON sp.po_id = po.id
    LEFT JOIN users u ON sp.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ` AND sp.supplier_id=?`; params.push(supplier_id); }
  if (po_id)       { sql += ` AND sp.po_id=?`;       params.push(po_id); }
  if (from_date)   { sql += ` AND sp.payment_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND sp.payment_date<=?`; params.push(to_date); }
  sql += ` ORDER BY sp.payment_date DESC LIMIT 300`;
  const payments = await all(sql, params);
  res.json({ payments: payments.map(p => ({ ...p, proof_image_path: buildFileUrl(req, p.proof_image_path) })) });
});

// ── POST /api/supplier-payments ──
// ── باج أمان مالي كان موجود هنا: التحقق من "المتبقي على أمر الشراء" كان بيتم
//    بقراءة targetPO *قبل* بدء الـ transaction، وبعدين قيمة paid_amount الجديدة
//    كانت بتتحسب في JavaScript (targetPO.paid_amount + paymentAmount) وتتكتب
//    كقيمة نهائية. تحت أي تزامن حقيقي (مستخدمين اتنين بيسجلوا دفعة على نفس أمر
//    الشراء في نفس اللحظة تقريباً)، الاتنين بيقروا نفس paid_amount القديم قبل
//    ما أي حد يخلّص، فالتحقق من "متبقي" بيعدي غلط على الاتنين، وبعدين كل واحد
//    بيكتب فوق قيمة التاني بدل ما تتجمع — ممكن يتسجل دفعتين فعلياً بقاعدة
//    supplier_payments لكن paid_amount على الـ PO يعكس دفعة واحدة بس (فلوس
//    "بتختفي" من رصيد المورد) أو العكس (سماح بدفع أكتر من المطلوب فعلياً).
//    الحل: قفل صف أمر الشراء (SELECT ... FOR UPDATE) *جوه* نفس الـ transaction
//    قبل أي تحقق أو تحديث، والتحديث نفسه بصيغة ذرّية (paid_amount = paid_amount + ?)
//    بدل قيمة محسوبة في الكود — كده أي طلب تاني بيوصل لنفس الصف هيستنى لحد ما
//    الأول يخلّص الـ commit، ويشوف القيمة المحدّثة فعلاً وقت التحقق.
router.post('/', authorize('admin','manager'), upload.single('proof_image'), async (req, res) => {
  const { supplier_id, po_id, amount, payment_method, payment_date, reference, notes, installment_id } = req.body;
  const proofImagePath = req.file ? `/uploads/payment_proofs/${req.file.filename}` : null;

  let payId;
  try {
    const result = await createSupplierPayment({
      supplier_id, po_id, amount, payment_method, payment_date, reference, notes,
      installment_id, proof_image_path: proofImagePath, user_id: req.user.id,
    });
    payId = result.id;
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  await logAction(req.user.id, 'create', 'supplier_payment', payId, { supplier_id, amount, po_id });
  const payment = await get(`SELECT * FROM supplier_payments WHERE id=?`,[payId]);
  const supplierForMsg = await get(`SELECT * FROM suppliers WHERE id=?`,[supplier_id]);
  const poForMsg = po_id ? await get(`SELECT * FROM purchase_orders WHERE id=?`,[po_id]) : null;
  eventBus.emit('supplier_payment.recorded', { payment, supplier: supplierForMsg, po: poForMsg, actorName: req.user.full_name });
  res.status(201).json({
    message: 'تم تسجيل الدفعة بنجاح',
    payment: { ...payment, proof_image_path: buildFileUrl(req, payment.proof_image_path) },
  });
});

// ── DELETE /api/supplier-payments/:id ── (إلغاء الدفعة)
router.delete('/:id', authorize('admin'), async (req, res) => {
  const pay = await get(`SELECT * FROM supplier_payments WHERE id=?`,[req.params.id]);
  if (!pay) return res.status(404).json({ error: 'الدفعة غير موجودة' });

  await transaction(async () => {
    // استرداد المبلغ من أمر الشراء
    if (pay.po_id) {
      await run(`UPDATE purchase_orders SET paid_amount = MAX(0, ROUND(paid_amount - ?,2)), updated_at=datetime('now') WHERE id=?`,
        [pay.amount, pay.po_id]);
    }
    // تراجع القسط إن كان مرتبطاً
    await run(`UPDATE payment_installments SET paid_amount=MAX(0,ROUND(paid_amount-?,2)), status='pending', payment_id=NULL
         WHERE payment_id=?`, [pay.amount, pay.id]);

    await run(`DELETE FROM supplier_payments WHERE id=?`,[req.params.id]);
  });

  // حذف ملف إثبات الدفع من القرص لو موجود (بعد نجاح حذف السجل من القاعدة)
  if (pay.proof_image_path) {
    const filePath = path.join(__dirname, '..', pay.proof_image_path.replace('/uploads', 'uploads'));
    fs.unlink(filePath, () => {});
  }

  await logAction(req.user.id, 'delete', 'supplier_payment', req.params.id, null);
  res.json({ message: 'تم إلغاء الدفعة بنجاح' });
});

module.exports = router;
module.exports.createSupplierPayment = createSupplierPayment;
module.exports.ELECTRONIC_METHODS = ELECTRONIC_METHODS;