// utils/commissionEngine.js
// يحسب ويُنشئ سجل عمولة تلقائياً عند تأكيد فاتورة بيع.
// مصمَّم ليكون "صامتاً" عند الفشل — أي خطأ هنا يجب ألا يوقف عملية تأكيد
// الفاتورة نفسها (نفس فلسفة auditLog.js في المشروع).
const { get, all, insert } = require('../db/database');
const { round2 } = require('./money');

// يحسب تكلفة البضاعة المباعة (COGS) لفاتورة معينة بناءً على سعر تكلفة المنتج الحالي
async function calcInvoiceCOGS(invoiceId) {
  const items = await all(
    `SELECT ii.quantity, p.cost_price
     FROM invoice_items ii JOIN products p ON ii.product_id = p.id
     WHERE ii.invoice_id = ?`,
    [invoiceId]
  );
  return items.reduce((sum, it) => sum + (it.quantity * (it.cost_price || 0)), 0);
}

// إيجاد قاعدة العمولة الخاصة بمستخدم معيّن، وإن لم توجد يرجع القاعدة الافتراضية
async function findRuleForUser(userId) {
  const specific = await get(`SELECT * FROM commission_rules WHERE user_id = ? AND is_active = 1`, [userId]);
  if (specific) return specific;
  return get(`SELECT * FROM commission_rules WHERE user_id IS NULL AND is_active = 1`);
}

// تُستدعى عند تأكيد الفاتورة. لا تُنشئ عمولة لو:
// - لا يوجد مستخدم مرتبط بالفاتورة
// - لا توجد قاعدة عمولة مفعّلة تنطبق عليه
// - إجمالي الفاتورة أقل من الحد الأدنى المطلوب في القاعدة
async function generateCommissionForInvoice(invoiceId) {
  try {
    const invoice = await get(`SELECT * FROM invoices WHERE id = ?`, [invoiceId]);
    if (!invoice || !invoice.user_id) return null;

    const already = await get(`SELECT id FROM commissions WHERE invoice_id = ?`, [invoiceId]);
    if (already) return null; // تجنّب التكرار لو أُعيد استدعاء التأكيد

    const rule = await findRuleForUser(invoice.user_id);
    if (!rule) return null;
    if (invoice.total < (rule.min_invoice_total || 0)) return null;

    let baseAmount = 0;
    let commissionAmount = 0;

    if (rule.rule_type === 'fixed_per_invoice') {
      baseAmount = invoice.total;
      commissionAmount = rule.rate;
    } else if (rule.rule_type === 'pct_sales') {
      baseAmount = invoice.total;
      commissionAmount = (invoice.total * rule.rate) / 100;
    } else {
      // pct_profit (الافتراضي): نسبة من هامش الربح الحقيقي = الإجمالي - تكلفة البضاعة - الخصم
      const cogs = await calcInvoiceCOGS(invoiceId);
      const profit = Math.max(0, invoice.total - cogs);
      baseAmount = profit;
      commissionAmount = (profit * rule.rate) / 100;
    }

    if (commissionAmount <= 0) return null;

    baseAmount = round2(baseAmount);
    commissionAmount = round2(commissionAmount);

    const id = await insert(
      `INSERT INTO commissions (invoice_id, user_id, rule_id, base_amount, rate, commission_amount, status)
       VALUES (?,?,?,?,?,?,'pending')`,
      [invoiceId, invoice.user_id, rule.id, baseAmount, rule.rate, commissionAmount]
    );
    return id;
  } catch (err) {
    console.error('تعذّر إنشاء سجل العمولة (لن يؤثر على تأكيد الفاتورة):', err.message);
    return null;
  }
}

module.exports = { generateCommissionForInvoice, calcInvoiceCOGS, findRuleForUser };
