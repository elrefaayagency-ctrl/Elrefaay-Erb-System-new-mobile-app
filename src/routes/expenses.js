// routes/expenses.js — وحدة المصروفات التشغيلية
const express = require('express');
const router = express.Router();
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

router.use(authenticate);

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genExpenseNumber() {
  return nextDocumentNumber('expense_number_seq', 'EXP', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM expenses`);
    return (r?.c || 0) + 1;
  });
}

// ═══ تصنيفات المصروفات ═══
router.get('/categories', async (req, res) => {
  const categories = (await all(`SELECT * FROM expense_categories ORDER BY name ASC`)).map(c => ({ ...c, is_active: !!c.is_active }));
  res.json({ categories });
});

router.post('/categories', authorize('admin', 'manager'), async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
  const existing = await get(`SELECT id FROM expense_categories WHERE name = ?`, [name.trim()]);
  if (existing) return res.status(400).json({ error: 'يوجد تصنيف بنفس الاسم' });
  const id = await insert(`INSERT INTO expense_categories (name, description) VALUES (?,?)`, [name.trim(), description || null]);
  res.status(201).json({ message: 'تم إضافة التصنيف', category: await get(`SELECT * FROM expense_categories WHERE id=?`, [id]) });
});

router.put('/categories/:id', authorize('admin', 'manager'), async (req, res) => {
  const cat = await get(`SELECT * FROM expense_categories WHERE id=?`, [req.params.id]);
  if (!cat) return res.status(404).json({ error: 'التصنيف غير موجود' });
  const { name, description, is_active } = req.body;
  await run(`UPDATE expense_categories SET name=?, description=?, is_active=? WHERE id=?`,
    [name?.trim() || cat.name, description ?? cat.description, is_active === undefined ? cat.is_active : (is_active ? 1 : 0), cat.id]);
  res.json({ message: 'تم التحديث', category: await get(`SELECT * FROM expense_categories WHERE id=?`, [cat.id]) });
});

router.delete('/categories/:id', authorize('admin', 'manager'), async (req, res) => {
  const inUse = await get(`SELECT COUNT(*) as c FROM expenses WHERE category_id=?`, [req.params.id]);
  if (inUse?.c > 0) return res.status(400).json({ error: 'لا يمكن حذف تصنيف مستخدم في مصروفات مسجّلة — يمكنك تعطيله بدلاً من ذلك' });
  await run(`DELETE FROM expense_categories WHERE id=?`, [req.params.id]);
  res.json({ message: 'تم الحذف' });
});

// ═══ المصروفات ═══
// GET /api/expenses?from=&to=&category_id=&location_id=&status=&search=
router.get('/', async (req, res) => {
  const { from, to, category_id, location_id, status, search } = req.query;
  let sql = `
    SELECT e.*, ec.name as category_name, l.name as location_name, u.full_name as user_name
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN locations l ON e.location_id = l.id
    LEFT JOIN users u ON e.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (from) { sql += ` AND e.expense_date >= ?`; params.push(from); }
  if (to)   { sql += ` AND e.expense_date <= ?`; params.push(to); }
  if (category_id) { sql += ` AND e.category_id = ?`; params.push(category_id); }
  if (location_id) { sql += ` AND e.location_id = ?`; params.push(location_id); }
  if (status)  { sql += ` AND e.status = ?`; params.push(status); }
  if (search) { sql += ` AND (e.expense_number LIKE ? OR e.vendor_name LIKE ? OR e.description LIKE ?)`; const t = `%${search}%`; params.push(t, t, t); }
  sql += ` ORDER BY e.expense_date DESC, e.id DESC`;

  const expenses = await all(sql, params);
  const total = expenses.filter(e => e.status !== 'rejected').reduce((s, e) => s + e.amount, 0);
  res.json({ expenses, count: expenses.length, total });
});

router.get('/:id', async (req, res) => {
  const expense = await get(`
    SELECT e.*, ec.name as category_name, l.name as location_name, u.full_name as user_name
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN locations l ON e.location_id = l.id
    LEFT JOIN users u ON e.user_id = u.id
    WHERE e.id=?`, [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'المصروف غير موجود' });
  res.json({ expense });
});

router.post('/', authorize('admin', 'manager'), async (req, res) => {
  const { category_id, location_id, amount, expense_date, payment_method,
          is_recurring, recurrence_period, vendor_name, description, status } = req.body;

  if (!category_id) return res.status(400).json({ error: 'تصنيف المصروف مطلوب' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });

  const cat = await get(`SELECT * FROM expense_categories WHERE id=?`, [category_id]);
  if (!cat) return res.status(404).json({ error: 'التصنيف غير موجود' });

  const expense_number = await genExpenseNumber();
  const id = await insert(
    `INSERT INTO expenses (expense_number, category_id, location_id, amount, expense_date, payment_method,
       is_recurring, recurrence_period, vendor_name, description, status, user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [expense_number, category_id, location_id || null, amount, expense_date || new Date().toISOString().slice(0, 10),
     payment_method || 'cash', is_recurring ? 1 : 0, is_recurring ? (recurrence_period || 'monthly') : null,
     vendor_name || null, description || null, status || 'approved', req.user.id]
  );

  await logAction(req.user.id, 'create', 'expense', id, { amount, category_id });
  res.status(201).json({ message: 'تم تسجيل المصروف', expense: await get(`SELECT * FROM expenses WHERE id=?`, [id]) });
});

router.put('/:id', authorize('admin', 'manager'), async (req, res) => {
  const expense = await get(`SELECT * FROM expenses WHERE id=?`, [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'المصروف غير موجود' });

  const { category_id, location_id, amount, expense_date, payment_method,
          is_recurring, recurrence_period, vendor_name, description, status } = req.body;

  if (amount !== undefined && amount <= 0) return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });

  await run(
    `UPDATE expenses SET category_id=?, location_id=?, amount=?, expense_date=?, payment_method=?,
       is_recurring=?, recurrence_period=?, vendor_name=?, description=?, status=?, updated_at=datetime('now')
     WHERE id=?`,
    [category_id ?? expense.category_id, location_id ?? expense.location_id, amount ?? expense.amount,
     expense_date || expense.expense_date, payment_method || expense.payment_method,
     is_recurring !== undefined ? (is_recurring ? 1 : 0) : expense.is_recurring,
     is_recurring ? (recurrence_period || expense.recurrence_period || 'monthly') : null,
     vendor_name ?? expense.vendor_name, description ?? expense.description,
     status || expense.status, expense.id]
  );

  await logAction(req.user.id, 'update', 'expense', expense.id, req.body);
  res.json({ message: 'تم تحديث المصروف', expense: await get(`SELECT * FROM expenses WHERE id=?`, [expense.id]) });
});

// ── DELETE /api/expenses/:id ──
// ── مشكلتين هنا: (1) كان مسموح للـ manager يحذف مش الـ admin بس، رغم إن ده
//    سجل مالي بيدخل في تقارير الأرباح والمصروفات. (2) كان DELETE فعلي (hard
//    delete) بغض النظر عن حالة المصروف — لو المصروف status='approved' وأصلاً
//    محسوب في تقرير شهر سابق، حذفه بيخليه يختفي بأثر رجعي من *كل* التقارير
//    القديمة كمان (reports.js بيحسب لايف من الجدول مباشرة)، وده مش سلوك مقبول
//    في أي نظام مالي احترافي — السجل المعتمد لازم يفضل موجود للتتبع حتى لو
//    اتلغى، والإلغاء نفسه لازم يبقى مسجّل. الحل: مصروف لسه 'pending' (لم
//    يُعتمد بعد ولم يدخل أي تقرير) يُحذف فعلياً بأمان، أما 'approved' فيتحول
//    لحالة 'rejected' (حذف منطقي/soft delete) بدل ما يتمسح بالكامل. ──
router.delete('/:id', authorize('admin'), async (req, res) => {
  const expense = await get(`SELECT * FROM expenses WHERE id=?`, [req.params.id]);
  if (!expense) return res.status(404).json({ error: 'المصروف غير موجود' });

  if (expense.status === 'approved') {
    await run(`UPDATE expenses SET status='rejected', updated_at=datetime('now') WHERE id=?`, [req.params.id]);
    await logAction(req.user.id, 'soft_delete', 'expense', req.params.id, { previous_status: 'approved' });
    return res.json({ message: 'هذا المصروف كان معتمداً ومُدرجاً بالفعل ضمن التقارير المالية — تم إلغاؤه (تحويله لحالة "مرفوض") بدل حذفه نهائياً حفاظاً على سلامة الأرشيف المالي' });
  }

  await run(`DELETE FROM expenses WHERE id=?`, [req.params.id]);
  await logAction(req.user.id, 'delete', 'expense', req.params.id, null);
  res.json({ message: 'تم حذف المصروف' });
});

module.exports = router;
