// routes/products.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { generateSKU, generateBarcode } = require('../utils/codeGenerator');
const { getProductStockRows, evaluateLowStock } = require('../utils/stockAlerts');
const eventBus = require('../utils/eventBus');

router.use(authenticate);

// ===================== رفع الصور =====================
const uploadsDir = path.join(__dirname, '../uploads/products');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB حد أقصى
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم. يُسمح فقط بـ JPG, PNG, WEBP, GIF'));
    }
  },
});

// دالة مساعدة لبناء الـ URL الكامل للصورة
const { buildFileUrl } = require('../utils/fileUrl');
function getImageUrl(req, imagePath) {
  return buildFileUrl(req, imagePath);
}

// دمج بيانات المخزون مع كل منتج (الكمية عبر كل المواقع + تقييم تنبيه المخزون
// المنخفض) — منطق التقييم نفسه بقى في utils/stockAlerts.js كمصدر حقيقة وحيد
// بدل ما يتكرر هنا وفي inventory.js بشكل منفصل.
async function attachStockSummary(products, req) {
  return Promise.all(products.map(async (p) => {
    const stockRows = await getProductStockRows(p.id);
    const evaluation = evaluateLowStock(p, stockRows);
    return {
      ...p,
      image_path: getImageUrl(req, p.image_path),
      is_active: !!p.is_active,
      allow_fractional_qty: !!p.allow_fractional_qty,
      stock_by_location: stockRows,
      total_quantity: evaluation.total_quantity,
      is_low_stock: evaluation.is_low_stock,
      low_stock_mode: p.low_stock_mode || 'global',
      low_stock_locations: evaluation.low_locations,
    };
  }));
}

// GET /api/products - قائمة المنتجات مع بحث وفلترة
router.get('/', async (req, res) => {
  const { search, category_id, low_stock, is_active } = req.query;
  let sql = `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1`;
  const params = [];

  if (search) {
    sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ? OR p.name_en LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }
  if (category_id) {
    sql += ` AND p.category_id = ?`;
    params.push(category_id);
  }
  if (is_active !== undefined) {
    sql += ` AND p.is_active = ?`;
    params.push(is_active === 'true' || is_active === '1' ? 1 : 0);
  }

  sql += ` ORDER BY p.created_at DESC`;

  let products = await all(sql, params);
  products = await attachStockSummary(products, req);

  // فلترة نواقص المخزون (تتم بعد حساب الكمية الإجمالية)
  if (low_stock === 'true') {
    products = products.filter((p) => p.is_low_stock);
  }

  // إخفاء سعر التكلفة عن المستخدمين غير المصرح لهم
  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    products = products.map((p) => {
      const { cost_price, ...rest } = p;
      return rest;
    });
  }

  res.json({ products, count: products.length });
});

// GET /api/products/:id - تفاصيل منتج واحد
router.get('/:id', async (req, res) => {
  const product = await get(
    `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`,
    [req.params.id]
  );
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });

  const [withStock] = await attachStockSummary([product], req);

  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    delete withStock.cost_price;
  }

  res.json({ product: withStock });
});

// GET /api/products/barcode/:barcode - البحث عن منتج بالباركود (للاستخدام مع قارئ الباركود)
router.get('/barcode/:barcode', async (req, res) => {
  const product = await get(
    `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.barcode = ?`,
    [req.params.barcode]
  );
  if (!product) return res.status(404).json({ error: 'لا يوجد منتج بهذا الباركود' });

  const [withStock] = await attachStockSummary([product], req);
  if (!req.user.can_view_cost_price && req.user.role !== 'admin') {
    delete withStock.cost_price;
  }
  res.json({ product: withStock });
});

// POST /api/products - إنشاء منتج جديد
router.post('/', authorize('admin', 'manager', 'warehouse'), upload.single('image'), async (req, res) => {
  try {
    let {
      sku,
      barcode,
      name,
      name_en,
      category_id,
      unit,
      allow_fractional_qty,
      cost_price,
      sale_price,
      min_stock_threshold,
      low_stock_mode,
      description,
      initial_quantities, // JSON string: [{location_id, quantity}]
      location_thresholds, // JSON string: [{location_id, min_stock_threshold}] — يُستخدم فقط لو low_stock_mode = per_location
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'اسم المنتج مطلوب' });
    }

    if (low_stock_mode && !['global', 'per_location'].includes(low_stock_mode)) {
      return res.status(400).json({ error: 'نمط تنبيه المخزون غير صحيح' });
    }

    const validUnits = ['piece', 'meter', 'liter', 'kg', 'set'];
    if (unit && !validUnits.includes(unit)) {
      return res.status(400).json({ error: 'وحدة القياس غير صحيحة' });
    }

    // توليد SKU تلقائياً إذا لم يُحدد
    if (!sku || sku.trim() === '') {
      sku = await generateSKU();
    } else {
      const existingSku = await get(`SELECT id FROM products WHERE sku = ?`, [sku]);
      if (existingSku) {
        return res.status(409).json({ error: 'هذا الكود (SKU) مستخدم بالفعل لمنتج آخر' });
      }
    }

    // توليد باركود تلقائياً إذا لم يُحدد
    if (!barcode || barcode.trim() === '') {
      barcode = await generateBarcode();
    } else {
      const existingBarcode = await get(`SELECT id FROM products WHERE barcode = ?`, [barcode]);
      if (existingBarcode) {
        return res.status(409).json({ error: 'هذا الباركود مستخدم بالفعل لمنتج آخر' });
      }
    }

    const imagePath = req.file ? `/uploads/products/${req.file.filename}` : null;

    const newProductId = await transaction(async () => {
      const productId = await insert(
        `INSERT INTO products (sku, barcode, name, name_en, category_id, unit, allow_fractional_qty, cost_price, sale_price, min_stock_threshold, low_stock_mode, description, image_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sku,
          barcode,
          name,
          name_en || null,
          category_id || null,
          unit || 'piece',
          allow_fractional_qty === 'true' || allow_fractional_qty === true ? 1 : 0,
          parseFloat(cost_price) || 0,
          parseFloat(sale_price) || 0,
          parseFloat(min_stock_threshold) || 0,
          low_stock_mode === 'per_location' ? 'per_location' : 'global',
          description || null,
          imagePath,
        ]
      );

      // تهيئة صفوف المخزون لكل المواقع بكمية صفر، ثم تطبيق الكميات المبدئية إن وُجدت
      const locations = await all(`SELECT id FROM locations WHERE is_active = 1`);
      let initialQtyMap = {};
      if (initial_quantities) {
        try {
          const parsed = JSON.parse(initial_quantities);
          parsed.forEach((item) => {
            initialQtyMap[item.location_id] = parseFloat(item.quantity) || 0;
          });
        } catch (e) {
          // تجاهل إذا كانت الصيغة غير صحيحة
        }
      }

      for (const loc of locations) {
        const qty = initialQtyMap[loc.id] || 0;
        await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, ?)`, [
          productId,
          loc.id,
          qty,
        ]);
        if (qty > 0) {
          await insert(
            `INSERT INTO stock_movements (product_id, location_id, movement_type, quantity, quantity_before, quantity_after, reference_type, notes, user_id)
             VALUES (?, ?, 'initial', ?, 0, ?, 'product_creation', 'كمية مبدئية عند إنشاء المنتج', ?)`,
            [productId, loc.id, qty, qty, req.user.id]
          );
        }
      }

      // حدود التنبيه لكل مخزن (Mode B) — تُحفظ فقط لو النمط per_location،
      // وبس للمواقع اللي المستخدم حدد لها رقم فعلي (تجنباً لتخزين صفوف
      // بلا فايدة لمنتج شغال بالنمط العادي Mode A)
      if (low_stock_mode === 'per_location' && location_thresholds) {
        try {
          const parsedThresholds = JSON.parse(location_thresholds);
          for (const t of parsedThresholds) {
            if (t.location_id == null || t.min_stock_threshold === '' || t.min_stock_threshold == null) continue;
            await insert(
              `INSERT INTO product_location_thresholds (product_id, location_id, min_stock_threshold)
               VALUES (?, ?, ?)`,
              [productId, t.location_id, parseFloat(t.min_stock_threshold) || 0]
            );
          }
        } catch (e) { /* تجاهل لو الصيغة غير صحيحة */ }
      }

      return productId;
    });

    await logAction(req.user.id, 'create', 'product', newProductId, { sku, name });

    const created = await get(`SELECT * FROM products WHERE id = ?`, [newProductId]);
    eventBus.emit('product.created', { product: created, actorName: req.user.full_name });
    res.status(201).json({ message: 'تم إنشاء المنتج بنجاح', product: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء المنتج: ' + err.message });
  }
});

// PUT /api/products/:id - تعديل منتج
router.put('/:id', authorize('admin', 'manager', 'warehouse'), upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

    let {
      sku,
      barcode,
      name,
      name_en,
      category_id,
      unit,
      allow_fractional_qty,
      cost_price,
      sale_price,
      min_stock_threshold,
      low_stock_mode,
      description,
      is_active,
      location_thresholds, // JSON string: [{location_id, min_stock_threshold}]
    } = req.body;

    if (low_stock_mode && !['global', 'per_location'].includes(low_stock_mode)) {
      return res.status(400).json({ error: 'نمط تنبيه المخزون غير صحيح' });
    }

    if (sku && sku !== existing.sku) {
      const dup = await get(`SELECT id FROM products WHERE sku = ? AND id != ?`, [sku, id]);
      if (dup) return res.status(409).json({ error: 'هذا الكود (SKU) مستخدم بالفعل لمنتج آخر' });
    }

    if (barcode && barcode !== existing.barcode) {
      const dup = await get(`SELECT id FROM products WHERE barcode = ? AND id != ?`, [barcode, id]);
      if (dup) return res.status(409).json({ error: 'هذا الباركود مستخدم بالفعل لمنتج آخر' });
    }

    let imagePath = existing.image_path;
    if (req.file) {
      imagePath = `/uploads/products/${req.file.filename}`;
      // حذف الصورة القديمة إن وُجدت
      if (existing.image_path) {
        const oldPath = path.join(__dirname, '..', existing.image_path.replace('/uploads', 'uploads'));
        fs.unlink(oldPath, () => {});
      }
    }

    await transaction(async () => {
      await run(
        `UPDATE products SET
          sku = ?, barcode = ?, name = ?, name_en = ?, category_id = ?, unit = ?,
          allow_fractional_qty = ?, cost_price = ?, sale_price = ?, min_stock_threshold = ?,
          low_stock_mode = ?, description = ?, image_path = ?, is_active = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          sku ?? existing.sku,
          barcode ?? existing.barcode,
          name ?? existing.name,
          name_en ?? existing.name_en,
          category_id !== undefined ? (category_id || null) : existing.category_id,
          unit ?? existing.unit,
          allow_fractional_qty !== undefined ? (allow_fractional_qty === 'true' || allow_fractional_qty === true ? 1 : 0) : existing.allow_fractional_qty,
          cost_price !== undefined ? parseFloat(cost_price) : existing.cost_price,
          sale_price !== undefined ? parseFloat(sale_price) : existing.sale_price,
          min_stock_threshold !== undefined ? parseFloat(min_stock_threshold) : existing.min_stock_threshold,
          low_stock_mode ?? existing.low_stock_mode,
          description ?? existing.description,
          imagePath,
          is_active !== undefined ? (is_active === 'true' || is_active === true ? 1 : 0) : existing.is_active,
          id,
        ]
      );

      // لو المستخدم بعت جدول حدود المخازن، بنستبدل الصفوف القديمة بالكامل
      // بالجديدة (upsert بسيط عن طريق حذف ثم إدراج، داخل نفس الـ transaction
      // عشان مايحصلش نصف تحديث لو حصل خطأ في المنتصف)
      if (location_thresholds !== undefined) {
        await run(`DELETE FROM product_location_thresholds WHERE product_id = ?`, [id]);
        try {
          const parsedThresholds = JSON.parse(location_thresholds);
          for (const t of parsedThresholds) {
            if (t.location_id == null || t.min_stock_threshold === '' || t.min_stock_threshold == null) continue;
            await insert(
              `INSERT INTO product_location_thresholds (product_id, location_id, min_stock_threshold)
               VALUES (?, ?, ?)`,
              [id, t.location_id, parseFloat(t.min_stock_threshold) || 0]
            );
          }
        } catch (e) { /* تجاهل لو الصيغة غير صحيحة */ }
      }
    });

    await logAction(req.user.id, 'update', 'product', id, req.body);
    const updated = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    eventBus.emit('product.updated', { product: updated, actorName: req.user.full_name });
    res.json({ message: 'تم تحديث المنتج بنجاح', product: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث المنتج: ' + err.message });
  }
});

// DELETE /api/products/:id/image - حذف صورة منتج فقط (بدون التأثير على باقي بيانات المنتج)
router.delete('/:id/image', authorize('admin', 'manager', 'warehouse'), async (req, res) => {
  const { id } = req.params;
  const existing = await get(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

  if (existing.image_path) {
    const oldPath = path.join(__dirname, '..', existing.image_path.replace('/uploads', 'uploads'));
    fs.unlink(oldPath, () => {});
  }

  await run(`UPDATE products SET image_path = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
  await logAction(req.user.id, 'update', 'product', id, { image_removed: true });
  res.json({ message: 'تم حذف صورة المنتج بنجاح' });
});

// DELETE /api/products/:id - تعطيل منتج (soft delete للحفاظ على سجل الحركات)
// كان مسموح للـ manager أيضاً — تم تقييده للـ admin فقط (طلب صريح: الحذف صلاحية Admin فقط)
router.delete('/:id', authorize('admin'), async (req, res) => {
  const { id } = req.params;
  const existing = await get(`SELECT id, name, sku FROM products WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'المنتج غير موجود' });

  await run(`UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
  await logAction(req.user.id, 'deactivate', 'product', id, null);
  eventBus.emit('product.deleted', { product: existing, actorName: req.user.full_name });
  res.json({ message: 'تم تعطيل المنتج بنجاح' });
});

// GET /api/products/:id/movements - سجل حركة منتج معين
router.get('/:id/movements', async (req, res) => {
  const movements = await all(
    `SELECT sm.*, l.name as location_name, u.full_name as user_name
     FROM stock_movements sm
     LEFT JOIN locations l ON sm.location_id = l.id
     LEFT JOIN users u ON sm.user_id = u.id
     WHERE sm.product_id = ?
     ORDER BY sm.created_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json({ movements });
});

// GET /api/products/print/barcode?ids=1,2,3 — جلب بيانات منتجات للطباعة
router.get('/print/barcode', async (req, res) => {
  const { ids } = req.query;
  let products;

  if (ids) {
    const idList = ids.split(',').map(s => parseInt(s.trim())).filter(Boolean);
    if (!idList.length) return res.json({ products: [] });
    const placeholders = idList.map(() => '?').join(',');
    products = await all(
      `SELECT p.id, p.name, p.name_en, p.sku, p.barcode, p.sale_price, p.image_path
       FROM products p
       WHERE p.id IN (${placeholders}) AND p.is_active = 1
       ORDER BY p.name`,
      idList
    );
  } else {
    products = await all(
      `SELECT p.id, p.name, p.name_en, p.sku, p.barcode, p.sale_price, p.image_path
       FROM products p
       WHERE p.is_active = 1 AND p.barcode IS NOT NULL AND p.barcode != ''
       ORDER BY p.name`
    );
  }

  products = products.map(p => ({
    ...p,
    image_path: getImageUrl(req, p.image_path),
  }));

  res.json({ products, count: products.length });
});

module.exports = router;