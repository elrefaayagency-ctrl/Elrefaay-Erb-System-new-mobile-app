// routes/locations.js
const express = require('express');
const router = express.Router();
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds, buildLocationFilter } = require('../utils/locationPermissions');

router.use(authenticate);

// GET /api/locations - يُرجع فقط المواقع المسموح للمستخدم برؤيتها
router.get('/', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  const filter = buildLocationFilter(allowedIds, 'l');

  const locations = await all(
    `SELECT l.* FROM locations l WHERE l.is_active = 1 ${filter} ORDER BY l.id ASC`
  );
  res.json({ locations: locations.map(l => ({ ...l, is_active: !!l.is_active })) });
});

// GET /api/locations/all - admin فقط: كل المواقع بدون فلتر (للإدارة وصفحة الصلاحيات)
router.get('/all', authorize('admin'), async (req, res) => {
  const locations = await all(`SELECT * FROM locations ORDER BY id ASC`);
  res.json({ locations: locations.map(l => ({ ...l, is_active: !!l.is_active })) });
});

// GET /api/locations/:id
router.get('/:id', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(req.params.id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية للوصول لهذا الموقع' });

  const location = await get(`SELECT * FROM locations WHERE id = ?`, [req.params.id]);
  if (!location) return res.status(404).json({ error: 'الموقع غير موجود' });
  res.json({ location });
});

// POST /api/locations
router.post('/', authorize('admin', 'manager'), async (req, res) => {
  const { name, type, address } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم الموقع مطلوب' });
  if (type && !['warehouse','showroom'].includes(type))
    return res.status(400).json({ error: 'نوع الموقع غير صحيح' });
  if (await get(`SELECT id FROM locations WHERE name = ?`, [name]))
    return res.status(409).json({ error: 'يوجد موقع بهذا الاسم بالفعل' });

  const newId = await insert(`INSERT INTO locations (name, type, address) VALUES (?, ?, ?)`,
    [name, type || 'warehouse', address || null]);

  // تهيئة مخزون صفري لكل المنتجات الحالية في الموقع الجديد
  const products = await all(`SELECT id FROM products`);
  for (const p of products) {
    await insert(`INSERT INTO inventory (product_id, location_id, quantity) VALUES (?, ?, 0)`, [p.id, newId]);
  }

  await logAction(req.user.id, 'create', 'location', newId, { name, type });
  res.status(201).json({ message: 'تم إنشاء الموقع بنجاح', location: { id: newId, name, type, address } });
});

// PUT /api/locations/:id
router.put('/:id', authorize('admin', 'manager'), async (req, res) => {
  const { id } = req.params;
  const { name, type, address, is_active } = req.body;
  const existing = await get(`SELECT * FROM locations WHERE id = ?`, [id]);
  if (!existing) return res.status(404).json({ error: 'الموقع غير موجود' });

  await run(`UPDATE locations SET name = ?, type = ?, address = ?, is_active = ? WHERE id = ?`,
    [name ?? existing.name, type ?? existing.type, address ?? existing.address,
     is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active, id]);

  await logAction(req.user.id, 'update', 'location', id, req.body);
  res.json({ message: 'تم تحديث الموقع بنجاح' });
});

// GET /api/locations/:id/inventory
router.get('/:id/inventory', async (req, res) => {
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(req.params.id)))
    return res.status(403).json({ error: 'ليس لديك صلاحية للوصول لهذا الموقع' });

  const inventory = await all(
    `SELECT i.*, p.sku, p.barcode, p.name as product_name, p.unit, p.min_stock_threshold, p.low_stock_mode, p.image_path,
            plt.min_stock_threshold as location_threshold
     FROM inventory i
     JOIN products p ON i.product_id = p.id
     LEFT JOIN product_location_thresholds plt ON plt.product_id = p.id AND plt.location_id = i.location_id
     WHERE i.location_id = ? AND p.is_active = 1 ORDER BY p.name ASC`,
    [req.params.id]
  );
  res.json({ inventory });
});

module.exports = router;