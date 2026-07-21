// routes/salesReturns.js
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genReturnNumber() {
  return nextDocumentNumber('return_number_seq', 'RTN', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM sales_returns`);
    return (r?.c || 0) + 1;
  });
}

// GET /api/sales-returns
router.get('/', async (req, res) => {
  const { customer_id, invoice_id, status } = req.query;
  let sql = `
    SELECT sr.*, c.name as customer_name, inv.invoice_number, u.full_name as created_by
    FROM sales_returns sr
    JOIN customers c ON sr.customer_id=c.id
    JOIN invoices inv ON sr.invoice_id=inv.id
    LEFT JOIN users u ON sr.user_id=u.id
    WHERE 1=1`;
  const params = [];
  if (customer_id) { sql += ` AND sr.customer_id=?`; params.push(customer_id); }
  if (invoice_id)  { sql += ` AND sr.invoice_id=?`;  params.push(invoice_id); }
  if (status)      { sql += ` AND sr.status=?`;      params.push(status); }
  sql += ` ORDER BY sr.created_at DESC LIMIT 200`;

  const returns_ = await all(sql, params);
  res.json({ returns: returns_, count: returns_.length });
});

// GET /api/sales-returns/:id
router.get('/:id', async (req, res) => {
  const r = await get(`
    SELECT sr.*, c.name as customer_name, inv.invoice_number, l.name as location_name
    FROM sales_returns sr
    JOIN customers c ON sr.customer_id=c.id
    JOIN invoices inv ON sr.invoice_id=inv.id
    JOIN locations l ON sr.location_id=l.id
    WHERE sr.id=?`,[req.params.id]);
  if (!r) return res.status(404).json({ error: 'المرتجع غير موجود' });

  const items = await all(`
    SELECT sri.*, p.name as product_name, p.sku, p.unit
    FROM sales_return_items sri JOIN products p ON sri.product_id=p.id
    WHERE sri.return_id=?`,[r.id]);

  res.json({ return: r, items });
});

// POST /api/sales-returns — إنشاء مرتجع (يحتاج موافقة ثم إكمال)
router.post('/', authorize('admin','manager','sales'), async (req, res) => {
  const { invoice_id, location_id, return_date, return_type, expected_return_date, reason, notes, items } = req.body;

  if (!invoice_id || !location_id)
    return res.status(400).json({ error: 'الفاتورة والموقع مطلوبان' });
  if (!items?.length)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });
  // إصلاح احترافي: منتج تحت الإصلاح لازم يكون له تاريخ استرجاع متوقع
  // مُلتزَم به للعميل — نفس مبدأ أي نظام RMA حقيقي
  if (return_type === 'repair' && !expected_return_date)
    return res.status(400).json({ error: 'مرتجع الإصلاح يحتاج تاريخ استرجاع متوقع للعميل' });

  const inv = await get(`SELECT * FROM invoices WHERE id=? AND status NOT IN ('draft','cancelled')`,[invoice_id]);
  if (!inv) return res.status(404).json({ error: 'الفاتورة غير موجودة أو لا يمكن إرجاعها' });

  // التحقق من الكميات المتوفرة للإرجاع
  let totalRefund = 0;
  for (const item of items) {
    const invItem = await get(`SELECT * FROM invoice_items WHERE id=? AND invoice_id=?`,[item.invoice_item_id, invoice_id]);
    if (!invItem) return res.status(400).json({ error: `البند رقم ${item.invoice_item_id} غير موجود في الفاتورة` });
    const alreadyReturned = invItem.returned_qty || 0;
    const maxReturn = invItem.quantity - alreadyReturned;
    if (item.quantity > maxReturn) {
      const prod = await get(`SELECT name FROM products WHERE id=?`,[invItem.product_id]);
      return res.status(400).json({ error: `الكمية المتاحة للإرجاع من "${prod?.name || 'المنتج'}" هي ${maxReturn} فقط` });
    }
    totalRefund += item.quantity * invItem.unit_price;
  }

  const returnId = await transaction(async () => {
    const returnNumber = await genReturnNumber();
    const id = await insert(`
      INSERT INTO sales_returns
      (return_number,invoice_id,customer_id,location_id,return_date,return_type,status,total_refund,reason,notes,expected_return_date,repair_status,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [returnNumber, invoice_id, inv.customer_id, location_id,
       return_date||new Date().toISOString().split('T')[0],
       return_type||'refund', 'pending', totalRefund, reason||null, notes||null,
       return_type==='repair' ? expected_return_date : null,
       return_type==='repair' ? 'in_repair' : 'none',
       req.user.id]
    );

    for (const item of items) {
      const invItem = await get(`SELECT * FROM invoice_items WHERE id=?`,[item.invoice_item_id]);
      await insert(`INSERT INTO sales_return_items (return_id,invoice_item_id,product_id,quantity,unit_price,condition,restock) VALUES (?,?,?,?,?,?,?)`,
        [id, item.invoice_item_id, invItem.product_id, item.quantity, invItem.unit_price,
         item.condition||'good', item.restock!==false?1:0]);
    }
    return id;
  });

  await logAction(req.user.id,'create','sales_return',returnId,{ invoice_id, total_refund: totalRefund });
  const createdReturn = await get(`
    SELECT sr.*, c.name as customer_name, inv.invoice_number
    FROM sales_returns sr JOIN customers c ON sr.customer_id=c.id JOIN invoices inv ON sr.invoice_id=inv.id
    WHERE sr.id=?`,[returnId]);
  eventBus.emit('sales_return.created', { ret: createdReturn, actorName: req.user.full_name });
  res.status(201).json({ message:'تم إنشاء طلب الإرجاع', return: createdReturn });
});

// POST /api/sales-returns/:id/approve — موافقة + تحديث المخزون + التسوية المالية
// حسب نوع المرتجع (احترافي — نفس مبدأ أنظمة RMA الكبرى):
//   refund       → استرداد نقدي فوري: تخفيض إجمالي/مدفوع الفاتورة الأصلية
//   store_credit → رصيد دائن للعميل يُستخدم في فاتورة قادمة (بدل نقدي فوري)
//   exchange     → لا تسوية مالية هنا؛ تُسوّى عبر فاتورة استبدال جديدة تُربط لاحقاً
//   repair       → لا استرداد ولا إعادة تخزين إطلاقاً؛ المنتج فعلياً عند
//                  الفني للإصلاح، مش على الرف للبيع — يفضل المرتجع "approved"
//                  (مش completed) لحد ما يترجع فعلياً للعميل عبر endpoint مخصص
router.post('/:id/approve', authorize('admin','manager'), async (req, res) => {
  const { exchange_invoice_id } = req.body;
  const ret = await get(`SELECT * FROM sales_returns WHERE id=?`,[req.params.id]);
  if (!ret) return res.status(404).json({ error: 'المرتجع غير موجود' });
  if (ret.status !== 'pending') return res.status(400).json({ error: 'يمكن الموافقة على المرتجعات المعلقة فقط' });

  const items = await all(`SELECT * FROM sales_return_items WHERE return_id=?`,[ret.id]);
  const isRepair = ret.return_type === 'repair';

  await transaction(async () => {
    for (const item of items) {
      // تحديث returned_qty في بند الفاتورة — يحصل دايماً بغض النظر عن النوع
      // (المنتج فعلياً خرج من عهدة العميل، سواء هيترجع للمخزون أو للإصلاح)
      await run(`UPDATE invoice_items SET returned_qty=returned_qty+? WHERE id=?`,[item.quantity, item.invoice_item_id]);

      // إعادة المخزون القابل للبيع — لكل الأنواع ما عدا "إصلاح": منتج تحت
      // الإصلاح مش سلعة جاهزة للبيع، فمينفعش يتحسب متاح في المخزون
      if (item.restock && !isRepair) {
        const stock  = await get(`SELECT * FROM inventory WHERE product_id=? AND location_id=? FOR UPDATE`,[item.product_id, ret.location_id]);
        const before = stock?.quantity || 0;
        const after  = before + item.quantity;
        if (stock) {
          await run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
            [after, item.product_id, ret.location_id]);
        } else {
          await insert(`INSERT INTO inventory (product_id,location_id,quantity) VALUES (?,?,?)`,
            [item.product_id, ret.location_id, after]);
        }
        await insert(`INSERT INTO stock_movements
          (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
          VALUES (?,?,'in',?,?,?,'sales_return',?,?,?)`,
          [item.product_id, ret.location_id, item.quantity, before, after, ret.id, `مرتجع مبيعات — ${ret.return_number}`, req.user.id]);
      }
    }

    // ── التسوية المالية حسب نوع المرتجع ──
    if (ret.return_type === 'refund' || ret.return_type === 'store_credit') {
      // في الحالتين، إجمالي الفاتورة الأصلية بينخفض (البضاعة فعلاً رجعت) —
      // الفرق إن refund بيرجع نقدي (يقلل المدفوع كمان)، وstore_credit بيتحول
      // لرصيد دائن للعميل بدل النقدي الفوري
      const inv = await get(`SELECT * FROM invoices WHERE id=? FOR UPDATE`,[ret.invoice_id]);
      if (inv) {
        const newTotal = inv.total - ret.total_refund;
        const newPaid  = ret.return_type === 'refund'
          ? Math.max(0, inv.paid_amount - ret.total_refund)
          : inv.paid_amount; // store_credit: العميل خلاص دفع، الفلوس بترجعله كرصيد مش نقدي من الفاتورة
        const newStatus = newTotal <= 0 ? 'refunded'
                        : newPaid >= newTotal ? 'paid'
                        : newPaid > 0 ? 'partial' : 'confirmed';
        await run(`UPDATE invoices SET paid_amount=?, total=?, status=?, updated_at=datetime('now') WHERE id=?`,
          [newPaid, newTotal, newStatus, ret.invoice_id]);
      }
      if (ret.return_type === 'store_credit') {
        await run(`UPDATE customers SET store_credit_balance = store_credit_balance + ?, updated_at=datetime('now') WHERE id=?`,
          [ret.total_refund, ret.customer_id]);
      }
    }
    // exchange: لا تسوية مالية آلية هنا — بتتسوى عبر فاتورة الاستبدال الجديدة
    // (لو رقمها اتبعت، بنربطها بالمرتجع للتوثيق بس)

    const finalStatus = isRepair ? 'approved' : 'completed';
    await run(`UPDATE sales_returns SET status=?, exchange_invoice_id=?, updated_at=datetime('now') WHERE id=?`,
      [finalStatus, exchange_invoice_id || ret.exchange_invoice_id || null, ret.id]);
  });

  await logAction(req.user.id,'approve','sales_return',ret.id,{ return_type: ret.return_type });
  const updated = await get(`
    SELECT sr.*, c.name as customer_name, inv.invoice_number
    FROM sales_returns sr JOIN customers c ON sr.customer_id=c.id JOIN invoices inv ON sr.invoice_id=inv.id
    WHERE sr.id=?`,[ret.id]);
  eventBus.emit('sales_return.completed', { ret: updated, actorName: req.user.full_name });
  res.json({
    message: isRepair ? 'تم قبول المرتجع — المنتج الآن قيد الإصلاح' : 'تم إتمام الإرجاع وتحديث المخزون',
    return: updated,
  });
});

// POST /api/sales-returns/:id/return-to-customer — تسليم منتج تم إصلاحه فعلياً للعميل
// (الخطوة الأخيرة في دورة مرتجع "إصلاح" — لا وجود لها في refund/exchange/store_credit)
router.post('/:id/return-to-customer', authorize('admin','manager','sales'), async (req, res) => {
  const ret = await get(`SELECT * FROM sales_returns WHERE id=?`,[req.params.id]);
  if (!ret) return res.status(404).json({ error: 'المرتجع غير موجود' });
  if (ret.return_type !== 'repair') return res.status(400).json({ error: 'هذا الإجراء خاص بمرتجعات الإصلاح فقط' });
  if (ret.status !== 'approved' || ret.repair_status !== 'in_repair')
    return res.status(400).json({ error: 'هذا المنتج ليس قيد الإصلاح حالياً' });

  await run(`UPDATE sales_returns SET status='completed', repair_status='returned_to_customer', updated_at=datetime('now') WHERE id=?`,[ret.id]);
  await logAction(req.user.id,'return_to_customer','sales_return',ret.id,null);
  res.json({ message: 'تم تسليم المنتج المُصلَح للعميل، واعتُبر المرتجع مكتملاً' });
});

// PUT /api/sales-returns/:id/reject
router.put('/:id/reject', authorize('admin','manager'), async (req, res) => {
  const { reason } = req.body;
  const ret = await get(`SELECT * FROM sales_returns WHERE id=?`,[req.params.id]);
  if (!ret || ret.status !== 'pending') return res.status(400).json({ error: 'لا يمكن رفض هذا المرتجع' });
  await run(`UPDATE sales_returns SET status='rejected', notes=COALESCE(?,notes) WHERE id=?`,[reason||null, req.params.id]);
  res.json({ message:'تم رفض المرتجع' });
});

module.exports = router;