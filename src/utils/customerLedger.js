// utils/customerLedger.js
// حساب رصيد العميل في الوقت الفعلي
const { get, run } = require('../db/database');

async function getCustomerBalance(customerId) {
  const customer = await get(`SELECT opening_balance FROM customers WHERE id=?`,[customerId]);
  if (!customer) return null;

  const invTotals = await get(`
    SELECT COALESCE(SUM(total),0) as total_invoiced
    FROM invoices WHERE customer_id=? AND status NOT IN ('draft','cancelled')
  `,[customerId]);

  const payTotals = await get(`
    SELECT COALESCE(SUM(amount),0) as total_paid
    FROM customer_payments WHERE customer_id=?
  `,[customerId]);

  const returnTotals = await get(`
    SELECT COALESCE(SUM(total_refund),0) as total_refunded
    FROM sales_returns WHERE customer_id=? AND status='completed'
  `,[customerId]);

  const totalInvoiced  = (customer.opening_balance||0) + (invTotals.total_invoiced||0);
  const totalPaid      = (payTotals.total_paid||0) + (returnTotals.total_refunded||0);
  const balance        = totalInvoiced - totalPaid; // موجب = العميل مدين لنا

  return {
    opening_balance:   customer.opening_balance||0,
    total_invoiced:    invTotals.total_invoiced||0,
    total_paid:        payTotals.total_paid||0,
    total_refunded:    returnTotals.total_refunded||0,
    balance,
  };
}

// ── التحقق من حد الائتمان قبل حفظ فاتورة آجلة/تقسيط ──
// بيتحقق فقط لما نوع الدفع "آجل" أو "تقسيط" (البيع النقدي مايهددش حد الائتمان).
// حد ائتمان = 0 يعني "غير مفعّل" لهذا العميل (مايتمنعش)، حسب الاتفاق الموضح
// في تلميح الحقل بالواجهة ("أقصى مديونية مسموحة... قبل ما النظام ينبّهك").
async function checkCreditLimit(customerId, invoiceTotal, paymentType) {
  if (paymentType !== 'credit' && paymentType !== 'installment') return null;

  const customer = await get(`SELECT credit_limit FROM customers WHERE id=?`,[customerId]);
  const creditLimit = customer?.credit_limit || 0;
  if (creditLimit <= 0) return null; // غير مفعّل لهذا العميل

  const ledger = await getCustomerBalance(customerId);
  const currentBalance   = ledger?.balance || 0;
  const projectedBalance = currentBalance + invoiceTotal;
  const available        = creditLimit - currentBalance;

  if (projectedBalance > creditLimit) {
    return {
      error: `تجاوز حد الائتمان: رصيد العميل الحالي ${currentBalance.toFixed(2)} ج.م، حد الائتمان ${creditLimit.toFixed(2)} ج.م، والمتاح ${Math.max(0, available).toFixed(2)} ج.م فقط — قيمة هذه الفاتورة ${invoiceTotal.toFixed(2)} ج.م تتجاوز المتاح. يمكن لمدير النظام فقط تجاوز هذا الحد.`,
      current_balance: currentBalance,
      credit_limit: creditLimit,
      available_credit: Math.max(0, available),
    };
  }
  return null;
}

async function syncCustomerInstallments(run_fn) {
  await require('./installmentEngine').syncOverdueInstallments('customer', run_fn);
}

module.exports = { getCustomerBalance, checkCreditLimit, syncCustomerInstallments };