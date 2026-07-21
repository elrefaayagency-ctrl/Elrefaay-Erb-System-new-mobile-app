// routes/transfers.js
const express = require('express');
const router = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds } = require('../utils/locationPermissions');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function generateTransferNumber() {
  return nextDocumentNumber('transfer_number_seq', 'TRF', 5, async () => {
    const result = await get(`SELECT COUNT(*) as count FROM stock_transfers`);
    return (result?.count || 0) + 1;
  });
}

// GET /api/transfers
router.get('/', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);

  // يعرض التحويلات التي يكون فيها المصدر أو الوجهة ضمن مواقعه المسموحة
  let locCondition = '';
  if (allowedIds) {
    const ids = allowedIds.join(',');
    locCondition = `AND (st.from_location_id IN (${ids}) OR st.to_location_id IN (${ids}))`;
  }

  const transfers = await all(`
    SELECT st.*,
           fl.name as from_location_name, tl.name as to_location_name,
           u.full_name as user_name
    FROM stock_transfers st
    JOIN locations fl ON st.from_location_id = fl.id
    JOIN locations tl ON st.to_location_id = tl.id
    LEFT JOIN users u ON st.user_id = u.id
    WHERE 1=1 ${locCondition}
    ORDER BY st.created_at DESC LIMIT 200
  `);

  const withItems = await Promise.all(transfers.map(async t => ({
    ...t,
    items: await all(`
      SELECT sti.*, p.name as product_name, p.sku, p.unit
      FROM stock_transfer_items sti JOIN products p ON sti.product_id = p.id
      WHERE sti.transfer_id = ?
    `, [t.id]),
  })));

  res.json({ transfers: withItems, count: withItems.length });
});

// POST /api/transfers
router.post('/', authorize('admin', 'manager', 'warehouse'), async (req, res) => {
  const { from_location_id, to_location_id, items, notes } = req.body;

  if (!from_location_id || !to_location_id)
    return res.status(400).json({ error: 'يرجى تحديد الموقع المصدر والوجهة' });
  if (Number(from_location_id) === Number(to_location_id))
    return res.status(400).json({ error: 'لا يمكن التحويل من وإلى نفس الموقع' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب تحديد منتج واحد على الأقل' });

  // التحقق من صلاحية الموقعين
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds) {
    if (!allowedIds.includes(Number(from_location_id)))
      return res.status(403).json({ error: 'ليس لديك صلاحية على الموقع المصدر' });
    if (!allowedIds.includes(Number(to_location_id)))
      return res.status(403).json({ error: 'ليس لديك صلاحية على الموقع الوجهة' });
  }

  const fromLocation = await get(`SELECT * FROM locations WHERE id = ?`, [from_location_id]);
  const toLocation   = await get(`SELECT * FROM locations WHERE id = ?`, [to_location_id]);
  if (!fromLocation) return res.status(404).json({ error: 'الموقع المصدر غير موجود' });
  if (!toLocation)   return res.status(404).json({ error: 'الموقع الوجهة غير موجود' });

  // التحقق من الكميات أولاً
  for (const item of items) {
    const { product_id, quantity } = item;
    if (!product_id || !quantity || quantity <= 0)
      return res.status(400).json({ error: 'كل عنصر يجب أن يحتوي على منتج وكمية صحيحة' });

    const product = await get(`SELECT * FROM products WHERE id = ?`, [product_id]);
    if (!product) return res.status(404).json({ error: `المنتج رقم ${product_id} غير موجود` });
    if (!product.allow_fractional_qty && quantity % 1 !== 0)
      return res.status(400).json({ error: `"${product.name}" لا يسمح بكميات كسرية` });

    const stock = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`,
      [product_id, from_location_id]);
    const available = stock?.quantity || 0;
    if (available < quantity)
      return res.status(400).json({
        error: `الكمية المتوفرة من "${product.name}" في ${fromLocation.name} هي ${available} فقط`,
      });
  }

  const transferId = await transaction(async () => {
    const transferNumber = await generateTransferNumber();
    const newId = await insert(
      `INSERT INTO stock_transfers (transfer_number, from_location_id, to_location_id, status, notes, user_id)
       VALUES (?, ?, ?, 'completed', ?, ?)`,
      [transferNumber, from_location_id, to_location_id, notes || null, req.user.id]
    );

    for (const item of items) {
      const qty = parseFloat(item.quantity);
      await insert(`INSERT INTO stock_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, ?)`,
        [newId, item.product_id, qty]);

      // FOR UPDATE + إعادة التحقق من الكمية *جوه* المعاملة نفسها — الفحص
      // اللي فات فوق (قبل بدء الـ transaction) للعرض السريع بس، مش حماية
      // حقيقية؛ تحويلين متزامنين لنفس المنتج من نفس المخزن كانوا ممكن
      // يعدّوا الفحص القديم الاتنين ويسحبوا كمية تخلي الرصيد سالب.
      const fromStock = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ? FOR UPDATE`,
        [item.product_id, from_location_id]);
      const fromBefore = fromStock?.quantity || 0;
      const fromAfter  = fromBefore - qty;
      if (fromAfter < 0) {
        const err = new Error(`الكمية المتوفرة من "${item.product_id}" في ${fromLocation.name} أصبحت ${fromBefore} فقط — أقل من المطلوب تحويله (${qty})`);
        err.status = 400;
        throw err;
      }
      await run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
        [fromAfter, item.product_id, from_location_id]);
      await insert(`INSERT INTO stock_movements
        (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, notes, user_id)
        VALUES (?, ?, 'transfer_out', ?, ?, ?, 'transfer', ?, ?, ?)`,
        [item.product_id, from_location_id, -qty, fromBefore, fromAfter, newId, `تحويل إلى ${toLocation.name}`, req.user.id]);

      const toStock = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ? FOR UPDATE`,
        [item.product_id, to_location_id]);
      const toBefore = toStock?.quantity || 0;
      const toAfter  = toBefore + qty;
      if (toStock) {
        await run(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND location_id = ?`,
          [toAfter, item.product_id, to_location_id]);
      } else {
        await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`,
          [item.product_id, to_location_id, toAfter]);
      }
      await insert(`INSERT INTO stock_movements
        (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, reference_id, notes, user_id)
        VALUES (?, ?, 'transfer_in', ?, ?, ?, 'transfer', ?, ?, ?)`,
        [item.product_id, to_location_id, qty, toBefore, toAfter, newId, `تحويل من ${fromLocation.name}`, req.user.id]);
    }
    return newId;
  });

  await logAction(req.user.id, 'create', 'transfer', transferId, { from_location_id, to_location_id });
  const createdTransfer = await get(`SELECT * FROM stock_transfers WHERE id = ?`, [transferId]);
  const transferItemsForMsg = await all(
    `SELECT sti.*, p.name as product_name FROM stock_transfer_items sti JOIN products p ON sti.product_id=p.id WHERE sti.transfer_id=?`,
    [transferId]);
  eventBus.emit('stock.transferred', {
    transfer: createdTransfer, items: transferItemsForMsg,
    fromLocation: fromLocation.name, toLocation: toLocation.name, actorName: req.user.full_name,
  });
  res.status(201).json({ message: 'تم التحويل بنجاح', transfer: createdTransfer });
});

module.exports = router;
