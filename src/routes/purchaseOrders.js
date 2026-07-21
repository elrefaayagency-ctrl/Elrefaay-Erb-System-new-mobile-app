// routes/purchaseOrders.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');
const { round2 }                             = require('../utils/money');
const { validateInstallmentSchedule }        = require('../utils/installmentEngine');
const { buildFileUrl }                       = require('../utils/fileUrl');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genPONumber() {
  return nextDocumentNumber('po_number_seq', 'PO', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM purchase_orders`);
    return (r?.c || 0) + 1;
  });
}

function calcPOTotals(items) {
  let subtotal = 0;
  const enriched = items.map(item => {
    const lineBeforeDisc = item.qty_ordered * item.unit_cost;
    const discAmt        = lineBeforeDisc * (item.discount_pct || 0) / 100;
    const lineTotal      = round2(lineBeforeDisc - discAmt);
    subtotal += lineTotal;
    return { ...item, line_total: lineTotal };
  });
  return { enriched, subtotal: round2(subtotal) };
}

// ── GET /api/purchase-orders ──
router.get('/', async (req, res) => {
  const { supplier_id, status, from_date, to_date } = req.query;
  let sql = `
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ` AND po.supplier_id=?`; params.push(supplier_id); }
  if (status)      { sql += ` AND po.status=?`;      params.push(status); }
  if (from_date)   { sql += ` AND po.order_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND po.order_date<=?`; params.push(to_date); }
  sql += ` ORDER BY po.created_at DESC LIMIT 300`;

  const orders = (await all(sql, params)).map(po => ({
    ...po,
    balance_due: po.total - po.paid_amount,
  }));
  res.json({ orders, count: orders.length });
});

// ── GET /api/purchase-orders/:id ──
router.get('/:id', async (req, res) => {
  const po = await get(`
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE po.id=?`, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  const items = await all(`
    SELECT poi.*, p.name as product_name, p.sku, p.unit, l.name as location_name
    FROM purchase_order_items poi
    JOIN products p ON poi.product_id = p.id
    LEFT JOIN locations l ON poi.location_id = l.id
    WHERE poi.po_id=?`, [po.id]);

  const receipts = await all(`
    SELECT pr.*, u.full_name as received_by
    FROM purchase_receipts pr
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.po_id=?`, [po.id]);

  const payments = (await all(`SELECT * FROM supplier_payments WHERE po_id=? ORDER BY payment_date ASC`, [po.id]))
    .map(p => ({ ...p, proof_image_path: buildFileUrl(req, p.proof_image_path) }));
  const installs = await all(`SELECT * FROM payment_installments WHERE po_id=? ORDER BY installment_number ASC`, [po.id]);

  res.json({ order: { ...po, balance_due: po.total - po.paid_amount }, items, receipts, payments, installments: installs });
});

// ── POST /api/purchase-orders ──
router.post('/', authorize('admin','manager'), async (req, res) => {
  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items, installments, purchase_type } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'المورد مطلوب' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });
  if (!await get(`SELECT id FROM suppliers WHERE id=? AND is_active=1`,[supplier_id]))
    return res.status(404).json({ error: 'المورد غير موجود أو غير نشط' });

  const poType = purchase_type === 'installment' ? 'installment' : 'cash';

  // كل بند لازم يكون له مخزن استلام محدد — إما مخزن خاص بيه أو مخزن الأمر
  // الافتراضي (location_id بالهيدر). ده بيسمح إن كل منتج في نفس أمر الشراء
  // يتوجّه لمخزن مختلف عن التاني.
  for (const item of items) {
    if (!item.location_id && !location_id)
      return res.status(400).json({ error: 'يجب تحديد مخزن الاستلام لكل بند (أو مخزن افتراضي للأمر بالكامل)' });
  }

  const { enriched, subtotal } = calcPOTotals(items);
  const discAmt = round2(parseFloat(discount_amount)||0);
  const taxAmt  = round2(parseFloat(tax_amount)||0);
  const total   = round2(subtotal - discAmt + taxAmt);

  // ── فحص جدول أقساط المورد — نفس الفحص المطبّق على أقساط العميل بالظبط.
  //    لو نوع الشراء "تقسيط"، الجدول بقى *إلزامي* (كان اختيارياً تماماً قبل
  //    كده حتى مع اختيار تقسيط، فمكن يتحفظ أمر "تقسيط" من غير أي جدول
  //    أقساط خالص) — بالضبط نفس مبدأ فاتورة المبيعات. ──
  if (poType === 'installment') {
    const installError = validateInstallmentSchedule(installments, total);
    if (installError) return res.status(400).json(installError);
  }

  const poId = await transaction(async () => {
    const poNumber = await genPONumber();
    const id = await insert(`
      INSERT INTO purchase_orders
      (po_number,supplier_id,location_id,order_date,expected_date,purchase_type,
       subtotal,discount_amount,tax_amount,total,paid_amount,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [poNumber, supplier_id, location_id||null,
       order_date || new Date().toISOString().split('T')[0],
       expected_date||null, poType, subtotal, discAmt, taxAmt, total, notes||null, req.user.id]);

    for (const item of enriched) {
      await insert(`INSERT INTO purchase_order_items
        (po_id,product_id,location_id,qty_ordered,unit_cost,discount_pct,line_total)
        VALUES (?,?,?,?,?,?,?)`,
        [id, item.product_id, item.location_id || location_id || null, item.qty_ordered, item.unit_cost,
         item.discount_pct||0, item.line_total]);
    }

    // إنشاء جدول الأقساط (لنوع "تقسيط" فقط)
    if (poType === 'installment' && Array.isArray(installments)) {
      for (let idx = 0; idx < installments.length; idx++) {
        const inst = installments[idx];
        await insert(`INSERT INTO payment_installments
          (supplier_id,po_id,installment_number,amount,due_date,notes)
          VALUES (?,?,?,?,?,?)`,
          [supplier_id, id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      }
    }

    return id;
  });

  await logAction(req.user.id, 'create', 'purchase_order', poId, { supplier_id, total, purchase_type: poType });
  const created = await get(`SELECT po.*, s.name as supplier_name FROM purchase_orders po JOIN suppliers s ON po.supplier_id=s.id WHERE po.id=?`,[poId]);
  const createdItems = await all(`SELECT poi.*, p.name as product_name FROM purchase_order_items poi JOIN products p ON poi.product_id=p.id WHERE poi.po_id=?`,[poId]);
  eventBus.emit('purchase_order.created', { order: created, items: createdItems, actorName: req.user.full_name });
  res.status(201).json({ message: 'تم إنشاء أمر الشراء بنجاح', order: created });
});

// ── PUT /api/purchase-orders/:id/status ──
// ملحوظة معمارية: 'received' و'partial' حالتين "مُشتقتين" (derived) بيتحكم فيهم
// نظام الاستلام تلقائياً حسب الكميات الفعلية المستلمة (شوف purchaseReceipts.js) —
// مش المفروض يتغيّروا يدوياً من هنا أبداً، وإلا ممكن حالة الـ PO تتناقض مع بيانات
// qty_received الفعلية المخزّنة على بنوده (نفس مبدأ SAP/Dynamics: الحالة نتيجة
// لأحداث العمل الفعلية، مش حقل حر يتعدّل بحرية). المسموح تغييره يدوياً هنا فقط:
// draft → sent (إرسال الأمر للمورد)، وأي حالة → cancelled (بشروط أمان أدناه).
router.put('/:id/status', authorize('admin','manager'), async (req, res) => {
  const { status } = req.body;
  const valid = ['draft','sent','partial','received','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const po = await get(`SELECT * FROM purchase_orders WHERE id=?`,[req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  if ((status === 'received' || status === 'partial') && po.status !== status) {
    return res.status(400).json({
      error: 'حالة "مستلم"/"استلام جزئي" تُحدَّث تلقائياً فقط عند تسجيل إيصال استلام فعلي، ولا يمكن ضبطها يدوياً',
    });
  }

  if (status === 'cancelled') {
    if (po.status === 'cancelled') return res.status(400).json({ error: 'أمر الشراء ملغى بالفعل' });
    if (Number(po.paid_amount) > 0)
      return res.status(400).json({
        error: 'لا يمكن إلغاء أمر شراء عليه دفعات مسجّلة — يجب استرداد/إلغاء الدفعات أولاً حتى لا يفسد رصيد المورد',
      });
    const receiptCount = await get(`SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id=?`,[po.id]);
    if (receiptCount?.c > 0)
      return res.status(400).json({
        error: 'لا يمكن إلغاء أمر شراء تم استلام بضاعة عليه بالفعل — البضاعة أصلاً أُضيفت للمخزون؛ استخدم مرتجع مشتريات بدلاً من ذلك',
      });
  }

  await run(`UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?`, [status, req.params.id]);
  await logAction(req.user.id, 'status_change', 'purchase_order', req.params.id, { from: po.status, to: status });
  res.json({ message: 'تم تحديث الحالة', status });
});

// ── PUT /api/purchase-orders/:id ── (تعديل الـ PO مع إعادة حساب الإجماليات)
// ── باج كان موجود هنا: الشرط كان بيمنع التعديل فقط لو status==='received'،
//    لكن حالة 'partial' (استلام جزئي) كانت لسه بتسمح بالتعديل! وبما إن التعديل
//    بيعمل DELETE FROM purchase_order_items ثم إعادة إدخال بنود جديدة من الصفر،
//    ده كان بيمسح عمود qty_received (تتبّع الكميات المستلمة فعلياً) لأي بند
//    تم استلامه جزئياً، وبيكسر أي مرجعية لـ purchase_receipt_items القديمة
//    اللي بتشاور على بنود الـ PO المحذوفة دي (FK) — كان بيرمي خطأ قاعدة بيانات
//    غامض للمستخدم بدل رسالة عربية واضحة، وأسوأ من كده: لو حصل أي تعديل يدوي
//    مباشر على قاعدة البيانات أو تغيّر سلوك FK مستقبلاً، ده ممكن يمسح تتبّع
//    الاستلام بصمت ويسمح باستلام نفس الكمية مرتين (تضخيم وهمي للمخزون).
//    الحل: نمنع التعديل الكامل للبنود بمجرد وجود أي إيصال استلام واحد على
//    الـ PO (مش بس لما يكتمل الاستلام)، برسالة عربية واضحة. تعديل PO مستلم
//    جزئياً منطقياً لازم يكون عبر "إضافة بند جديد" وليس استبدال كامل البنود.
router.put('/:id', authorize('admin','manager'), async (req, res) => {
  const { id } = req.params;
  const po = await get(`SELECT * FROM purchase_orders WHERE id=?`,[id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });
  if (po.status === 'received')
    return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء مكتمل الاستلام' });
  if (po.status === 'cancelled')
    return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء ملغى' });

  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items } = req.body;

  if (items && items.length > 0) {
    const receiptCount = await get(`SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id=?`,[id]);
    if (receiptCount?.c > 0)
      return res.status(400).json({
        error: 'لا يمكن استبدال بنود أمر شراء تم تسجيل استلام عليه بالفعل — أي تعديل ممكن يمسح سجل الكميات المستلمة ويسمح باستلامها مرة أخرى بالخطأ',
      });
  }

  await transaction(async () => {
    if (items && items.length > 0) {
      const { enriched, subtotal } = calcPOTotals(items);
      const discAmt = round2(discount_amount !== undefined ? parseFloat(discount_amount) || 0 : po.discount_amount);
      const taxAmt  = round2(tax_amount !== undefined ? parseFloat(tax_amount) || 0 : po.tax_amount);
      const total   = round2(subtotal - discAmt + taxAmt);

      // ── منع خفض الإجمالي لأقل من المبلغ المدفوع فعلاً — وإلا balance_due يبقى سالب
      //    ويوهم إن المورد مدين لينا بينما إحنا فعلياً دفعنا أكتر من قيمة الأمر ──
      if (total < Number(po.paid_amount)) {
        const err = new Error(`لا يمكن تقليل إجمالي أمر الشراء (${total.toFixed(2)}) لأقل من المبلغ المدفوع فعلاً (${Number(po.paid_amount).toFixed(2)})`);
        err.status = 400;
        throw err;
      }

      await run(`UPDATE purchase_orders SET
        supplier_id=?, location_id=?, order_date=?, expected_date=?,
        subtotal=?, discount_amount=?, tax_amount=?, total=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
        [supplier_id??po.supplier_id, location_id??po.location_id,
         order_date??po.order_date, expected_date??po.expected_date,
         subtotal, discAmt, taxAmt, total, notes??po.notes, id]);

      await run(`DELETE FROM purchase_order_items WHERE po_id=?`,[id]);
      for (const item of enriched) {
        await insert(`INSERT INTO purchase_order_items
          (po_id,product_id,location_id,qty_ordered,unit_cost,discount_pct,line_total)
          VALUES (?,?,?,?,?,?,?)`,
          [id, item.product_id, item.location_id || location_id || po.location_id || null,
           item.qty_ordered, item.unit_cost, item.discount_pct||0, item.line_total]);
      }
    }
  }).catch(err => {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  });

  if (res.headersSent) return;
  await logAction(req.user.id, 'update', 'purchase_order', id, { supplier_id, items_replaced: !!(items && items.length) });
  res.json({ order: await get(`SELECT * FROM purchase_orders WHERE id=?`,[id]) });
});

module.exports = router;
