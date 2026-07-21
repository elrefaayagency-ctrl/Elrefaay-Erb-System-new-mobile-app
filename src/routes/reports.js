// routes/reports.js — المرحلة الرابعة: التقارير ولوحة التحكم
const express = require('express');
const router = express.Router();
const { all, get } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getSupplierBalance } = require('../utils/supplierLedger');
const { getCustomerBalance } = require('../utils/customerLedger');
const { getDueAsOfDate } = require('../utils/installmentEngine');
const { round2 } = require('../utils/money');

// ─── أداء: تنفيذ عدد محدود من العمليات المتزامنة بدل Promise.all بلا حدود ───
// تقرير الأرصدة (/balances) بيحسب رصيد كل مورد/عميل عبر 3 استعلامات SQL
// منفصلة لكل واحد (getSupplierBalance/getCustomerBalance). لو عدد الموردين
// أو العملاء كبير (مئات)، Promise.all العادي كان بيطلق كل الاستعلامات دفعة
// واحدة، وده ممكن ياكل الـ connection pool كله (10 اتصالات افتراضياً) ويعطّل
// بقية طلبات السيرفر لحظياً لحد ما التقرير يخلص. هنا بنحدد أقصى تزامن 6
// عشان يفضل فيه اتصالات فاضية لبقية النظام أثناء توليد التقرير.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

router.use(authenticate);
router.use(authorize('admin', 'manager'));

// ═══ تقرير المبيعات (يومي / شهري / سنوي) ═══
// GET /api/reports/sales?period=daily|monthly|yearly&from=&to=
router.get('/sales', async (req, res) => {
  const { period = 'daily', from, to } = req.query;
  const bucket = period === 'yearly' ? "strftime('%Y', invoice_date)"
               : period === 'monthly' ? "strftime('%Y-%m', invoice_date)"
               : "invoice_date";

  let sql = `
    SELECT ${bucket} as period, COUNT(*) as invoice_count,
           SUM(total) as total_sales, SUM(discount_amount) as total_discount,
           SUM(paid_amount) as total_collected
    FROM invoices WHERE status NOT IN ('draft','cancelled')`;
  const params = [];
  if (from) { sql += ` AND invoice_date >= ?`; params.push(from); }
  if (to)   { sql += ` AND invoice_date <= ?`; params.push(to); }
  sql += ` GROUP BY period ORDER BY period ASC`;

  const rows = await all(sql, params);
  const totals = rows.reduce((acc, r) => ({
    total_sales: acc.total_sales + (r.total_sales || 0),
    invoice_count: acc.invoice_count + (r.invoice_count || 0),
  }), { total_sales: 0, invoice_count: 0 });

  res.json({ rows, totals });
});

// ═══ تقرير الأرباح الحقيقية (بعد المصروفات) ═══
// GET /api/reports/profit?from=&to=
router.get('/profit', async (req, res) => {
  const { from, to } = req.query;
  const dateFilterInv = [];
  let invSql = `SELECT inv.id, inv.total, inv.discount_amount FROM invoices inv WHERE inv.status NOT IN ('draft','cancelled')`;
  if (from) { invSql += ` AND inv.invoice_date >= ?`; dateFilterInv.push(from); }
  if (to)   { invSql += ` AND inv.invoice_date <= ?`; dateFilterInv.push(to); }
  const invoices = await all(invSql, dateFilterInv);

  let revenue = 0, cogs = 0;
  const invoiceIds = invoices.map(i => i.id);
  revenue = invoices.reduce((s, i) => s + i.total, 0);

  if (invoiceIds.length) {
    const placeholders = invoiceIds.map(() => '?').join(',');
    const cogsRow = await get(`
      SELECT COALESCE(SUM(ii.quantity * p.cost_price), 0) as cogs
      FROM invoice_items ii JOIN products p ON ii.product_id = p.id
      WHERE ii.invoice_id IN (${placeholders})`, invoiceIds);
    cogs = cogsRow?.cogs || 0;
  }

  const grossProfit = revenue - cogs;

  let expSql = `SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE status='approved'`;
  const expParams = [];
  if (from) { expSql += ` AND expense_date >= ?`; expParams.push(from); }
  if (to)   { expSql += ` AND expense_date <= ?`; expParams.push(to); }
  const expRow = await get(expSql, expParams);
  const totalExpenses = expRow?.total || 0;

  let commSql = `
    SELECT COALESCE(SUM(c.commission_amount),0) as total
    FROM commissions c JOIN invoices inv ON c.invoice_id = inv.id
    WHERE c.status != 'cancelled'`;
  const commParams = [];
  if (from) { commSql += ` AND inv.invoice_date >= ?`; commParams.push(from); }
  if (to)   { commSql += ` AND inv.invoice_date <= ?`; commParams.push(to); }
  const commRow = await get(commSql, commParams);
  const totalCommissions = commRow?.total || 0;

  const netProfit = grossProfit - totalExpenses - totalCommissions;

  res.json({
    revenue, cogs, grossProfit,
    totalExpenses, totalCommissions, netProfit,
    grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
    netMarginPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
  });
});

// ═══ تقرير تقييم المخزون ═══
router.get('/inventory-valuation', async (req, res) => {
  const rows = await all(`
    SELECT p.id, p.sku, p.name, c.name as category_name, p.unit,
           SUM(i.quantity) as total_qty, p.cost_price, p.sale_price,
           SUM(i.quantity) * p.cost_price as cost_value,
           SUM(i.quantity) * p.sale_price as retail_value
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = 1
    GROUP BY p.id, c.name
    HAVING SUM(i.quantity) > 0
    ORDER BY cost_value DESC`);

  const totals = rows.reduce((acc, r) => ({
    cost_value: acc.cost_value + (r.cost_value || 0),
    retail_value: acc.retail_value + (r.retail_value || 0),
    total_qty: acc.total_qty + (r.total_qty || 0),
  }), { cost_value: 0, retail_value: 0, total_qty: 0 });

  res.json({ rows, totals });
});

// ═══ أكثر المنتجات مبيعاً والراكدة + مؤشر الطلب الذكي ═══
// GET /api/reports/product-performance?from=&to=&limit=
router.get('/product-performance', async (req, res) => {
  const { from, to, limit = 20 } = req.query;
  let sql = `
    SELECT p.id, p.sku, p.name, c.name as category_name, p.unit,
           COALESCE(SUM(ii.quantity), 0) as qty_sold,
           COALESCE(SUM(ii.line_total), 0) as revenue,
           COALESCE(SUM(ii.quantity * p.cost_price), 0) as cogs,
           MAX(inv.invoice_date) as last_sale_date,
           COALESCE((SELECT SUM(quantity) FROM inventory WHERE product_id = p.id), 0) as current_stock
    FROM products p
    LEFT JOIN invoice_items ii ON ii.product_id = p.id
    LEFT JOIN invoices inv ON ii.invoice_id = inv.id AND inv.status NOT IN ('draft','cancelled')`;
  const params = [];
  const whereClauses = [];
  if (from) { whereClauses.push(`inv.invoice_date >= ?`); params.push(from); }
  if (to)   { whereClauses.push(`inv.invoice_date <= ?`); params.push(to); }
  if (whereClauses.length) sql += ` AND ` + whereClauses.join(' AND ');
  sql += ` LEFT JOIN categories c ON p.category_id = c.id WHERE p.is_active = 1 GROUP BY p.id, c.name`;

  const rows = await all(sql, params);

  // ── مؤشر الطلب الذكي (لوني): يقارن معدل البيع الأخير بحجم المخزون الحالي ──
  const withDemand = rows.map(r => {
    const daysSinceLastSale = r.last_sale_date
      ? Math.floor((Date.now() - new Date(r.last_sale_date).getTime()) / 86400000)
      : null;
    let demand = 'none'; // لا مبيعات إطلاقاً
    if (r.qty_sold > 0) {
      if (daysSinceLastSale !== null && daysSinceLastSale <= 14 && r.qty_sold >= 5) demand = 'high';       // 🟢 طلب مرتفع
      else if (daysSinceLastSale !== null && daysSinceLastSale <= 45) demand = 'medium';                    // 🟡 طلب متوسط
      else demand = 'low';                                                                                    // 🟠 طلب منخفض / راكد نسبياً
    } else if (r.current_stock > 0) {
      demand = 'stagnant';                                                                                    // 🔴 راكد تماماً (مخزون بدون أي بيع)
    }
    return { ...r, days_since_last_sale: daysSinceLastSale, demand };
  });

  const topSelling = [...withDemand].sort((a, b) => b.qty_sold - a.qty_sold).filter(r => r.qty_sold > 0).slice(0, Number(limit));
  const stagnant = withDemand.filter(r => r.demand === 'stagnant' || (r.demand === 'low' && r.current_stock > 0))
    .sort((a, b) => b.current_stock - a.current_stock).slice(0, Number(limit));

  res.json({ all: withDemand, topSelling, stagnant });
});

// ═══ تقرير أرصدة الموردين والعملاء ═══
router.get('/balances', async (req, res) => {
  const supplierRows = await all(`SELECT id, code, name, phone FROM suppliers WHERE is_active = 1`);
  const suppliers = (await mapWithConcurrency(supplierRows, 6, async s => ({ ...s, ...(await getSupplierBalance(s.id)) })))
    .filter(s => Math.abs(s.balance) > 0.01);

  const customerRows = await all(`SELECT id, code, name, phone FROM customers WHERE is_active = 1`);
  const customers = (await mapWithConcurrency(customerRows, 6, async c => ({ ...c, ...(await getCustomerBalance(c.id)) })))
    .filter(c => Math.abs(c.balance) > 0.01);

  const totals = {
    total_payable_to_suppliers: suppliers.reduce((s, x) => s + Math.max(0, x.balance), 0),
    total_receivable_from_customers: customers.reduce((s, x) => s + Math.max(0, x.balance), 0),
  };

  res.json({ suppliers, customers, totals });
});

// ═══ تقرير المصروفات المصنّفة ═══
router.get('/expenses-by-category', async (req, res) => {
  const { from, to } = req.query;
  let sql = `
    SELECT ec.id, ec.name, COUNT(e.id) as expense_count, COALESCE(SUM(e.amount),0) as total
    FROM expense_categories ec
    LEFT JOIN expenses e ON e.category_id = ec.id AND e.status = 'approved'`;
  const params = [];
  const clauses = [];
  if (from) { clauses.push(`e.expense_date >= ?`); params.push(from); }
  if (to)   { clauses.push(`e.expense_date <= ?`); params.push(to); }
  if (clauses.length) sql += ` AND ` + clauses.join(' AND ');
  sql += ` GROUP BY ec.id ORDER BY total DESC`;

  const rows = await all(sql, params);
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  res.json({ rows, grandTotal });
});

// ═══ مؤشرات لوحة التحكم الرئيسية (KPIs) ═══
router.get('/dashboard-kpis', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const salesToday = await get(`SELECT COALESCE(SUM(total),0) as t, COUNT(*) as c FROM invoices WHERE invoice_date = ? AND status NOT IN ('draft','cancelled')`, [today]);
  const salesMonth = await get(`SELECT COALESCE(SUM(total),0) as t, COUNT(*) as c FROM invoices WHERE invoice_date >= ? AND status NOT IN ('draft','cancelled')`, [monthStart]);
  const expensesMonth = await get(`SELECT COALESCE(SUM(amount),0) as t FROM expenses WHERE expense_date >= ? AND status='approved'`, [monthStart]);
  const commissionsMonth = await get(`
    SELECT COALESCE(SUM(c.commission_amount),0) as t FROM commissions c
    JOIN invoices inv ON c.invoice_id = inv.id
    WHERE inv.invoice_date >= ? AND c.status != 'cancelled'`, [monthStart]);
  const pendingCommissions = await get(`SELECT COALESCE(SUM(commission_amount),0) as t FROM commissions WHERE status='pending'`);

  const cogsMonthRow = await get(`
    SELECT COALESCE(SUM(ii.quantity * p.cost_price),0) as cogs
    FROM invoice_items ii
    JOIN invoices inv ON ii.invoice_id = inv.id
    JOIN products p ON ii.product_id = p.id
    WHERE inv.invoice_date >= ? AND inv.status NOT IN ('draft','cancelled')`, [monthStart]);

  const netProfitMonth = (salesMonth.t || 0) - (cogsMonthRow.cogs || 0) - (expensesMonth.t || 0) - (commissionsMonth.t || 0);

  const inventoryValue = await get(`SELECT COALESCE(SUM(i.quantity * p.cost_price),0) as v FROM inventory i JOIN products p ON i.product_id=p.id`);

  const salesTrend = await all(`
    SELECT invoice_date as day, COALESCE(SUM(total),0) as total
    FROM invoices
    WHERE invoice_date >= date('now','-13 days') AND status NOT IN ('draft','cancelled')
    GROUP BY invoice_date ORDER BY invoice_date ASC`);

  res.json({
    salesToday: { total: salesToday.t || 0, count: salesToday.c || 0 },
    salesMonth: { total: salesMonth.t || 0, count: salesMonth.c || 0 },
    expensesMonth: expensesMonth.t || 0,
    commissionsMonth: commissionsMonth.t || 0,
    pendingCommissions: pendingCommissions.t || 0,
    netProfitMonth,
    inventoryValue: inventoryValue.v || 0,
    salesTrend,
  });
});

// ═══ تقرير تحصيل الأقساط بالمحافظة/المنطقة (المرحلة 6) ═══
// GET /api/reports/collections?governorate=&area=&date=YYYY-MM-DD
//
// الحساب هنا كامل عبر installmentEngine.getDueAsOfDate — مفيش أي منطق
// حساب رصيد أو استحقاق مكرر هنا؛ الراوت مسؤوليته الوحيدة هي الفلترة
// الجغرافية وتجميع النتيجة في شكل تقرير قابل للطباعة.
router.get('/collections', async (req, res) => {
  const { governorate, area, date } = req.query;
  const reportDate = date || new Date().toISOString().split('T')[0];

  let sql = `SELECT * FROM customers WHERE is_active = 1`;
  const params = [];
  if (governorate) { sql += ` AND governorate = ?`; params.push(governorate); }
  if (area)        { sql += ` AND area = ?`;        params.push(area); }
  sql += ` ORDER BY governorate, area, name`;
  const customers = await all(sql, params);

  // المستحق التراكمي حتى تاريخ التقرير لكل عميل — مصدر واحد للحساب
  const dueRows = await getDueAsOfDate('customer', reportDate);
  const dueByCustomer = {};
  dueRows.forEach(r => { dueByCustomer[r.account_id] = r; });

  const rows = customers
    .map(c => {
      const due = dueByCustomer[c.id];
      return {
        customer_id: c.id,
        customer_code: c.code,
        customer_name: c.name,
        address: c.address,
        governorate: c.governorate,
        area: c.area,
        responsible_person: c.contact_person,
        phone: c.phone,
        phone2: c.phone2,
        installments_due_count: due ? due.installments_count : 0,
        outstanding_amount: due ? round2(due.due_amount) : 0,
        notes: c.notes,
      };
    })
    // بنعرض بس العملاء اللي عليهم فعلاً مستحق حتى تاريخ التقرير — ده جوهر
    // التقرير (قوائم تحصيل)، مش كشف بكل العملاء بغض النظر عن مديونيتهم
    .filter(r => r.outstanding_amount > 0.01);

  res.json({
    report_date: reportDate,
    governorate: governorate || null,
    area: area || null,
    count: rows.length,
    total_outstanding: round2(rows.reduce((s, r) => s + r.outstanding_amount, 0)),
    rows,
  });
});

module.exports = router;