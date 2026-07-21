// routes/purchaseReceipts.js
// إيصالات الاستلام — تحدّث المخزون تلقائياً عند الحفظ
const express = require('express');
const router  = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');
const { round2 }                             = require('../utils/money');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genReceiptNumber() {
  return nextDocumentNumber('receipt_number_seq', 'GRN', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM purchase_receipts`);
    return (r?.c || 0) + 1;
  });
}

// ── GET /api/purchase-receipts ──
router.get('/', async (req, res) => {
  const { po_id, supplier_id } = req.query;
  let sql = `
    SELECT pr.*, po.po_number, s.name as supplier_name, l.name as location_name, u.full_name as received_by
    FROM purchase_receipts pr
    JOIN purchase_orders po ON pr.po_id = po.id
    JOIN suppliers s ON pr.supplier_id = s.id
    JOIN locations l ON pr.location_id = l.id
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (po_id)       { sql += ` AND pr.po_id=?`;        params.push(po_id); }
  if (supplier_id) { sql += ` AND pr.supplier_id=?`;  params.push(supplier_id); }
  sql += ` ORDER BY pr.created_at DESC LIMIT 200`;

  const receipts = await all(sql, params);
  res.json({ receipts, count: receipts.length });
});

// ── GET /api/purchase-receipts/:id ──
router.get('/:id', async (req, res) => {
  const r = await get(`
    SELECT pr.*, po.po_number, s.name as supplier_name, l.name as location_name, u.full_name as received_by
    FROM purchase_receipts pr
    JOIN purchase_orders po ON pr.po_id = po.id
    JOIN suppliers s ON pr.supplier_id = s.id
    JOIN locations l ON pr.location_id = l.id
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.id=?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'الإيصال غير موجود' });

  const items = await all(`
    SELECT pri.*, p.name as product_name, p.sku, p.unit, l.name as location_name
    FROM purchase_receipt_items pri
    JOIN products p ON pri.product_id = p.id
    LEFT JOIN locations l ON pri.location_id = l.id
    WHERE pri.receipt_id=?`, [r.id]);

  res.json({ receipt: r, items });
});

// ── POST /api/purchase-receipts ── (الأهم: يحدّث المخزون + qty_received في PO)
router.post('/', authorize('admin','manager','warehouse'), async (req, res) => {
  const { po_id, receipt_date, notes, items } = req.body;
  // location_id بالهيدر بقى اختياري الآن — كل بند بياخد مخزنه المحدد أصلاً
  // في أمر الشراء (poItem.location_id)، أو ممكن يتغيّر لحظة الاستلام لو
  // اتبعت location_id مع البند نفسه. الهيدر بس fallback ولعرض اسم مخزن
  // تمثيلي في قوائم الإيصالات.
  const headerLocationId = req.body.location_id || null;

  if (!po_id)
    return res.status(400).json({ error: 'أمر الشراء مطلوب' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });

  const po = await get(`SELECT * FROM purchase_orders WHERE id=?`,[po_id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });
  if (po.status === 'cancelled')
    return res.status(400).json({ error: 'لا يمكن الاستلام على أمر شراء ملغي' });

  // التحقق من الكميات المتبقية + تحديد مخزن كل بند (بند الاستلام → بند أمر
  // الشراء → مخزن الهيدر، بهذا الترتيب) والتأكد إن كل بند له مخزن معروف
  const resolvedItems = [];
  for (const item of items) {
    const poItem = await get(`SELECT * FROM purchase_order_items WHERE id=? AND po_id=?`,
      [item.po_item_id, po_id]);
    if (!poItem) return res.status(400).json({ error: `البند رقم ${item.po_item_id} غير موجود` });
    const remaining = poItem.qty_ordered - poItem.qty_received;
    if (item.qty_received > remaining)
      return res.status(400).json({
        error: `الكمية المطلوبة (${item.qty_received}) تتجاوز المتبقي (${remaining}) للمنتج رقم ${poItem.product_id}`
      });

    const itemLocationId = item.location_id || poItem.location_id || headerLocationId;
    if (!itemLocationId)
      return res.status(400).json({ error: `يجب تحديد مخزن الاستلام للمنتج رقم ${poItem.product_id}` });

    resolvedItems.push({ ...item, poItem, location_id: itemLocationId });
  }

  // التحقق من صلاحية كل مخزن مُستهدف (وليس مخزن واحد فقط بالهيدر)
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds) {
    const uniqueLocs = [...new Set(resolvedItems.map(i => Number(i.location_id)))];
    const forbidden = uniqueLocs.filter(l => !allowedIds.includes(l));
    if (forbidden.length)
      return res.status(403).json({ error: 'ليس لديك صلاحية على أحد المخازن المحددة لبنود هذا الإيصال' });
  }

  // مخزن تمثيلي لعنوان الإيصال نفسه (عمود location_id بالهيدر إلزامي في القاعدة)
  const displayLocationId = headerLocationId || resolvedItems[0].location_id;

  const receiptId = await transaction(async () => {
    const receiptNumber = await genReceiptNumber();
    const rId = await insert(`
      INSERT INTO purchase_receipts (receipt_number,po_id,supplier_id,location_id,receipt_date,notes,user_id)
      VALUES (?,?,?,?,?,?,?)`,
      [receiptNumber, po_id, po.supplier_id, displayLocationId,
       receipt_date || new Date().toISOString().split('T')[0],
       notes||null, req.user.id]);

    for (const item of resolvedItems) {
      const { poItem, location_id } = item;
      const unitCost = item.unit_cost ?? poItem.unit_cost;

      // إصلاح race condition: الفحص الأول لـ "الكمية المتبقية" (فوق، قبل
      // المعاملة) بيتعمل من غير lock، فإيصالين استلام متزامنين لنفس بند
      // الـ PO ممكن الاتنين يقروا نفس qty_received القديمة ويعدّوا الفحص
      // مع بعض، فيستلموا كمية إجمالية أكبر من المطلوب فعلياً (over-receiving).
      // هنا بنعيد القراءة والتحقق تاني، لكن هذه المرة FOR UPDATE جوه
      // المعاملة، فالإيصال التاني هيستنى لحد ما الأول يخلص ويشوف الرقم
      // المحدّث فعلياً قبل ما يتحقق.
      const lockedPoItem = await get(`SELECT qty_ordered, qty_received FROM purchase_order_items WHERE id=? FOR UPDATE`,
        [poItem.id]);
      const stillRemaining = lockedPoItem.qty_ordered - lockedPoItem.qty_received;
      if (item.qty_received > stillRemaining) {
        const e = new Error(`الكمية المطلوبة (${item.qty_received}) تتجاوز المتبقي الفعلي (${stillRemaining}) للمنتج رقم ${poItem.product_id} — على الأرجح إيصال استلام آخر تم تسجيله لنفس البند للتو`);
        e.status = 400; throw e;
      }

      await insert(`INSERT INTO purchase_receipt_items (receipt_id,po_item_id,product_id,location_id,qty_received,unit_cost)
        VALUES (?,?,?,?,?,?)`,
        [rId, item.po_item_id, poItem.product_id, location_id, item.qty_received, unitCost]);

      // تحديث qty_received في بند PO
      await run(`UPDATE purchase_order_items SET qty_received = qty_received + ? WHERE id=?`,
        [item.qty_received, item.po_item_id]);

      // ─── تحديث المخزون (في المخزن الخاص بهذا البند تحديداً) ───
      // FOR UPDATE: إيصالين استلام متزامنين لنفس المنتج/المخزن لازم
      // يتصفّوا (queue) بدل ما يقرأوا نفس الكمية القديمة ويضيع أحد الاستلامين
      const inv = await get(`SELECT * FROM inventory WHERE product_id=? AND location_id=? FOR UPDATE`,
        [poItem.product_id, location_id]);
      const before = inv?.quantity || 0;
      const after  = before + item.qty_received;

      if (inv) {
        await run(`UPDATE inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`,
          [after, poItem.product_id, location_id]);
      } else {
        await insert(`INSERT INTO inventory (product_id,location_id,quantity) VALUES (?,?,?)`,
          [poItem.product_id, location_id, after]);
      }

      await insert(`INSERT INTO stock_movements
        (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,
         reference_type,reference_id,notes,user_id)
        VALUES (?,?,'in',?,?,?,'purchase_receipt',?,?,?)`,
        [poItem.product_id, location_id, item.qty_received, before, after,
         rId, `استلام بضاعة — إيصال ${receiptNumber}`, req.user.id]);

      // ─── تحديث سعر التكلفة في جدول المنتجات (متوسط مرجّح — Weighted Average) ───
      // مهم جداً: سعر التكلفة (cost_price) حقل واحد مشترك للمنتج على مستوى الشركة كلها،
      // مش لكل مخزن لوحده. لازم نحسب المتوسط المرجّح على إجمالي المخزون في *كل* المخازن
      // مجتمعة (قبل هذا الاستلام)، مش بس مخزون المخزن اللي بيستقبل البضاعة دلوقتي —
      // وإلا هيتحرّف سعر التكلفة كل مرة يوصل توريد لمخزن مختلف عن اللي فيه المخزون الأكبر.
      const currentProduct = await get(`SELECT cost_price FROM products WHERE id=? FOR UPDATE`,[poItem.product_id]);
      const totalStockAllLocations = await get(
        `SELECT COALESCE(SUM(quantity),0) as total FROM inventory WHERE product_id=?`,
        [poItem.product_id]
      );
      const stockBeforeReceipt = round2(totalStockAllLocations.total - item.qty_received);
      const newCost = stockBeforeReceipt > 0
        ? round2(((currentProduct.cost_price * stockBeforeReceipt) + (unitCost * item.qty_received)) / (stockBeforeReceipt + item.qty_received))
        : round2(unitCost);
      await run(`UPDATE products SET cost_price=?, updated_at=datetime('now') WHERE id=?`,
        [newCost, poItem.product_id]);
    }

    // تحديث حالة PO بناءً على الكميات المستلمة
    const allItems = await all(`SELECT qty_ordered, qty_received FROM purchase_order_items WHERE po_id=?`,[po_id]);
    const allReceived = allItems.every(i => i.qty_received >= i.qty_ordered);
    const anyReceived = allItems.some(i => i.qty_received > 0);
    const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
    await run(`UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?`,[newStatus, po_id]);

    return rId;
  });

  await logAction(req.user.id, 'create', 'purchase_receipt', receiptId, { po_id });
  const createdReceipt = await get(`
    SELECT r.*, s.name as supplier_name, po.po_number, l.name as location_name, u.full_name as received_by
    FROM purchase_receipts r
    JOIN suppliers s ON r.supplier_id = s.id
    JOIN purchase_orders po ON r.po_id = po.id
    LEFT JOIN locations l ON r.location_id = l.id
    LEFT JOIN users u ON r.user_id = u.id
    WHERE r.id=?`, [receiptId]);
  eventBus.emit('goods_receipt.created', { receipt: createdReceipt, actorName: req.user.full_name });
  res.status(201).json({
    message: 'تم تسجيل الاستلام وتحديث المخزون بنجاح',
    receipt: createdReceipt,
  });
});

module.exports = router;