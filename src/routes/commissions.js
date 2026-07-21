// routes/commissions.js — وحدة العمولات والحوافز
const express = require('express');
const router = express.Router();
const { all, get, run, insert } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');

router.use(authenticate);

// ═══ قواعد العمولات ═══
router.get('/rules', authorize('admin', 'manager'), async (req, res) => {
  const rulesRaw = await all(`
    SELECT cr.*, u.full_name as user_name
    FROM commission_rules cr LEFT JOIN users u ON cr.user_id = u.id
    ORDER BY (cr.user_id IS NULL) DESC, u.full_name ASC`
  );
  const rules = rulesRaw.map(r => ({ ...r, is_active: !!r.is_active }));
  res.json({ rules });
});

router.post('/rules', authorize('admin', 'manager'), async (req, res) => {
  const { user_id, rule_type, rate, min_invoice_total, is_active } = req.body;
  if (rate === undefined || rate < 0) return res.status(400).json({ error: 'النسبة/القيمة مطلوبة' });
  if (!['pct_sales', 'pct_profit', 'fixed_per_invoice'].includes(rule_type))
    return res.status(400).json({ error: 'نوع القاعدة غير صحيح' });

  const existing = await get(`SELECT id FROM commission_rules WHERE user_id ${user_id ? '= ?' : 'IS NULL'}`, user_id ? [user_id] : []);
  if (existing) return res.status(400).json({ error: 'يوجد بالفعل قاعدة لهذا المستخدم — يمكنك تعديلها' });

  const id = await insert(
    `INSERT INTO commission_rules (user_id, rule_type, rate, min_invoice_total, is_active) VALUES (?,?,?,?,?)`,
    [user_id || null, rule_type, rate, min_invoice_total || 0, is_active === false ? 0 : 1]
  );
  await logAction(req.user.id, 'create', 'commission_rule', id, req.body);
  res.status(201).json({ message: 'تم إضافة قاعدة العمولة', rule: await get(`SELECT * FROM commission_rules WHERE id=?`, [id]) });
});

router.put('/rules/:id', authorize('admin', 'manager'), async (req, res) => {
  const rule = await get(`SELECT * FROM commission_rules WHERE id=?`, [req.params.id]);
  if (!rule) return res.status(404).json({ error: 'القاعدة غير موجودة' });
  const { rule_type, rate, min_invoice_total, is_active } = req.body;
  await run(
    `UPDATE commission_rules SET rule_type=?, rate=?, min_invoice_total=?, is_active=?, updated_at=datetime('now') WHERE id=?`,
    [rule_type || rule.rule_type, rate ?? rule.rate, min_invoice_total ?? rule.min_invoice_total,
     is_active === undefined ? rule.is_active : (is_active ? 1 : 0), rule.id]
  );
  await logAction(req.user.id, 'update', 'commission_rule', rule.id, req.body);
  res.json({ message: 'تم تحديث القاعدة', rule: await get(`SELECT * FROM commission_rules WHERE id=?`, [rule.id]) });
});

// حذف قاعدة عمولة — للـ admin فقط (طلب صريح: الحذف صلاحية Admin فقط)
router.delete('/rules/:id', authorize('admin'), async (req, res) => {
  const rule = await get(`SELECT * FROM commission_rules WHERE id=?`, [req.params.id]);
  if (!rule) return res.status(404).json({ error: 'القاعدة غير موجودة' });
  if (rule.user_id === null) return res.status(400).json({ error: 'لا يمكن حذف القاعدة الافتراضية — يمكنك تعطيلها فقط' });
  await run(`DELETE FROM commission_rules WHERE id=?`, [req.params.id]);
  res.json({ message: 'تم حذف القاعدة' });
});

// ═══ سجلات العمولات ═══
// GET /api/commissions?from=&to=&user_id=&status=
router.get('/', async (req, res) => {
  const { from, to, user_id, status } = req.query;
  let sql = `
    SELECT c.*, inv.invoice_number, inv.invoice_date, inv.total as invoice_total,
           u.full_name as user_name, cust.name as customer_name
    FROM commissions c
    JOIN invoices inv ON c.invoice_id = inv.id
    JOIN users u ON c.user_id = u.id
    JOIN customers cust ON inv.customer_id = cust.id
    WHERE 1=1`;
  const params = [];

  // مندوب المبيعات يرى عمولاته فقط، أما الإدارة فترى الجميع
  if (req.user.role === 'sales') { sql += ` AND c.user_id = ?`; params.push(req.user.id); }
  else if (user_id) { sql += ` AND c.user_id = ?`; params.push(user_id); }

  if (from) { sql += ` AND inv.invoice_date >= ?`; params.push(from); }
  if (to)   { sql += ` AND inv.invoice_date <= ?`; params.push(to); }
  if (status) { sql += ` AND c.status = ?`; params.push(status); }
  sql += ` ORDER BY inv.invoice_date DESC, c.id DESC`;

  const commissions = await all(sql, params);
  const totalPending = commissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.commission_amount, 0);
  const totalPaid = commissions.filter(c => c.status === 'paid').reduce((s, c) => s + c.commission_amount, 0);
  res.json({ commissions, count: commissions.length, totalPending, totalPaid });
});

// تقرير شهري مجمّع لكل مندوب
router.get('/monthly-summary', authorize('admin', 'manager'), async (req, res) => {
  const { year } = req.query;
  const y = year || new Date().getFullYear();
  const rows = await all(`
    SELECT u.id as user_id, u.full_name as user_name,
           strftime('%Y-%m', inv.invoice_date) as month,
           COUNT(*) as invoice_count,
           SUM(c.commission_amount) as total_commission,
           SUM(CASE WHEN c.status='paid' THEN c.commission_amount ELSE 0 END) as paid_commission,
           SUM(CASE WHEN c.status='pending' THEN c.commission_amount ELSE 0 END) as pending_commission
    FROM commissions c
    JOIN invoices inv ON c.invoice_id = inv.id
    JOIN users u ON c.user_id = u.id
    WHERE strftime('%Y', inv.invoice_date) = ?
    GROUP BY u.id, month
    ORDER BY month DESC, u.full_name ASC`, [String(y)]);
  res.json({ summary: rows });
});

// تعليم عمولة أو أكثر كمدفوعة
router.post('/pay', authorize('admin', 'manager'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'يجب تحديد عمولة واحدة على الأقل' });
  for (const id of ids) {
    await run(`UPDATE commissions SET status='paid', paid_date=date('now'), updated_at=datetime('now') WHERE id=? AND status='pending'`, [id]);
  }
  await logAction(req.user.id, 'pay', 'commission', null, { ids });
  res.json({ message: 'تم تسجيل صرف العمولات المحددة' });
});

router.put('/:id/cancel', authorize('admin', 'manager'), async (req, res) => {
  const c = await get(`SELECT * FROM commissions WHERE id=?`, [req.params.id]);
  if (!c) return res.status(404).json({ error: 'سجل العمولة غير موجود' });
  await run(`UPDATE commissions SET status='cancelled', updated_at=datetime('now') WHERE id=?`, [c.id]);
  res.json({ message: 'تم إلغاء العمولة' });
});

module.exports = router;
