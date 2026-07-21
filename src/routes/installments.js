// routes/installments.js
const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { syncOverdueInstallments, getInstallmentDashboard } = require('../utils/installmentEngine');

router.use(authenticate);

// ── GET /api/installments ── (كل الأقساط مع فلاتر)
router.get('/', async (req, res) => {
  await syncOverdueInstallments('supplier');
  const { supplier_id, status, overdue_only } = req.query;
  let sql = `
    SELECT pi.*, s.name as supplier_name, s.code as supplier_code,
           po.po_number
    FROM payment_installments pi
    JOIN suppliers s ON pi.supplier_id = s.id
    LEFT JOIN purchase_orders po ON pi.po_id = po.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id)  { sql += ` AND pi.supplier_id=?`; params.push(supplier_id); }
  if (status)       { sql += ` AND pi.status=?`;      params.push(status); }
  if (overdue_only === 'true') { sql += ` AND pi.status='overdue'`; }
  sql += ` ORDER BY pi.due_date ASC`;

  res.json({ installments: await all(sql, params) });
});

// ── GET /api/installments/dashboard ── (ملخص للوحة التحكم)
router.get('/dashboard', async (req, res) => {
  res.json(await getInstallmentDashboard('supplier'));
});

module.exports = router;
