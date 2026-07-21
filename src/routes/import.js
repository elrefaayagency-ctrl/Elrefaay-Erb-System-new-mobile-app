// routes/import.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { all, get, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { generateSKU, generateBarcode } = require('../utils/codeGenerator');

router.use(authenticate);

const tempDir = path.join(__dirname, '../uploads/temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({
  dest: tempDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('يُسمح فقط بملفات Excel (.xlsx, .xls) أو CSV'));
  },
});

// GET /api/import/template - تحميل قالب Excel جاهز للتعبئة
router.get('/template', authorize('admin', 'manager', 'warehouse'), async (req, res) => {
  const headers = [
    'name', 'sku', 'barcode', 'category', 'unit', 'cost_price', 'sale_price', 'min_stock_threshold', 'description',
  ];
  const sampleRow = [
    'نجف كريستال فاخر', '', '', 'نجف كريستال', 'piece', '500', '850', '5', 'نجف كريستال 12 لمبة',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
  XLSX.utils.book_append_sheet(wb, ws, 'المنتجات');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// POST /api/import/products - استيراد منتجات بالجملة من ملف Excel/CSV
router.post('/products', authorize('admin', 'manager', 'warehouse'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'يرجى رفع ملف Excel أو CSV' });
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    fs.unlink(req.file.path, () => {}); // تنظيف الملف المؤقت

    if (rows.length === 0) {
      return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات صحيحة' });
    }

    const validUnits = ['piece', 'meter', 'liter', 'kg', 'set'];
    const results = { success: [], errors: [] };

    const categories = await all(`SELECT id, name FROM categories`);
    const categoryMap = {};
    categories.forEach((c) => (categoryMap[c.name.trim()] = c.id));

    const locations = await all(`SELECT id FROM locations WHERE is_active = 1`);

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2; // +2 لأن الصف الأول هو العنوان والفهرسة تبدأ من 1
      try {
        const name = String(row.name || row['اسم المنتج'] || '').trim();
        if (!name) {
          results.errors.push({ row: rowNum, error: 'اسم المنتج مطلوب' });
          continue;
        }

        let sku = String(row.sku || row['الكود'] || '').trim();
        let barcode = String(row.barcode || row['الباركود'] || '').trim();
        const categoryName = String(row.category || row['التصنيف'] || '').trim();
        let unit = String(row.unit || row['الوحدة'] || 'piece').trim();
        const costPrice = parseFloat(row.cost_price || row['سعر التكلفة'] || 0) || 0;
        const salePrice = parseFloat(row.sale_price || row['سعر البيع'] || 0) || 0;
        const minStock = parseFloat(row.min_stock_threshold || row['حد التنبيه'] || 0) || 0;
        const description = String(row.description || row['الوصف'] || '').trim();

        if (!validUnits.includes(unit)) unit = 'piece';

        if (sku) {
          const existingSku = await get(`SELECT id FROM products WHERE sku = ?`, [sku]);
          if (existingSku) {
            results.errors.push({ row: rowNum, error: `الكود "${sku}" مستخدم بالفعل` });
            continue;
          }
        } else {
          sku = await generateSKU();
        }

        if (barcode) {
          const existingBarcode = await get(`SELECT id FROM products WHERE barcode = ?`, [barcode]);
          if (existingBarcode) {
            results.errors.push({ row: rowNum, error: `الباركود "${barcode}" مستخدم بالفعل` });
            continue;
          }
        } else {
          barcode = await generateBarcode();
        }

        const categoryId = categoryName ? categoryMap[categoryName] || null : null;

        const productId = await transaction(async () => {
          const id = await insert(
            `INSERT INTO products (sku, barcode, name, category_id, unit, cost_price, sale_price, min_stock_threshold, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sku, barcode, name, categoryId, unit, costPrice, salePrice, minStock, description || null]
          );

          for (const loc of locations) {
            await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, 0)`, [id, loc.id]);
          }

          return id;
        });

        results.success.push({ row: rowNum, product_id: productId, sku, name });
      } catch (err) {
        results.errors.push({ row: rowNum, error: err.message });
      }
    }

    await logAction(req.user.id, 'bulk_import', 'product', null, {
      total_rows: rows.length,
      success: results.success.length,
      errors: results.errors.length,
    });

    res.json({
      message: `تم استيراد ${results.success.length} منتج بنجاح من أصل ${rows.length}`,
      total_rows: rows.length,
      imported: results.success.length,
      failed: results.errors.length,
      success_details: results.success,
      error_details: results.errors,
    });
  } catch (err) {
    console.error(err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'حدث خطأ أثناء قراءة الملف: ' + err.message });
  }
});

module.exports = router;
