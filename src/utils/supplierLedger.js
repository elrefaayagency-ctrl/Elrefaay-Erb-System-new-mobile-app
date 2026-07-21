// utils/supplierLedger.js
// حساب رصيد المورد في الوقت الفعلي من مجموع الأوامر والمدفوعات
const { get, all } = require('../db/database');

async function getSupplierBalance(supplierId) {
  const supplier = await get(`SELECT opening_balance FROM suppliers WHERE id = ?`, [supplierId]);
  if (!supplier) return null;

  // ملحوظة معمارية مهمة: كان هنا باج تضارب حسابي حقيقي — الفلتر القديم كان
  // IN ('partial','received') يعني أمر الشراء مايتحسبش كالتزام مالي على المورد
  // إلا لو استُلمت بضاعته (جزئياً أو كلياً)، بينما شاشة أوامر الشراء نفسها
  // بتعرض "الإجمالي/المدفوع/المتبقي" لكل أمر بغض النظر عن حالته. النتيجة:
  // أمر شراء بحالة "مرسل" (sent) لسه ماوصلتش بضاعته، لو اتسجلت عليه دفعة،
  // كان بيظهر "إجمالي مشتريات = 0" في بروفايل المورد بينما شاشة الأوامر
  // بتوريه إجمالي حقيقي — تناقض تام في نفس اللحظة بين شاشتين لنفس البيانات.
  // الحل: نفس مبدأ دفتر أستاذ العميل بالظبط (customerLedger.js) — الالتزام
  // يتحسب بمجرد خروج الأمر من "مسودة" (draft)، مش بس عند الاستلام؛ لأن
  // "مسودة" فقط هي المرحلة اللي لسه مش التزام حقيقي تجاه المورد.
  const poTotals = await get(`
    SELECT COALESCE(SUM(total), 0) as total_invoiced
    FROM purchase_orders
    WHERE supplier_id = ? AND status NOT IN ('draft','cancelled')
  `, [supplierId]);

  // إجمالي المدفوعات
  const payTotals = await get(`
    SELECT COALESCE(SUM(amount), 0) as total_paid
    FROM supplier_payments
    WHERE supplier_id = ?
  `, [supplierId]);

  const totalInvoiced = (supplier.opening_balance || 0) + (poTotals.total_invoiced || 0);
  const totalPaid     = payTotals.total_paid || 0;
  const balance       = totalInvoiced - totalPaid;

  return {
    opening_balance:  supplier.opening_balance || 0,
    total_invoiced:   poTotals.total_invoiced || 0,
    total_paid:       totalPaid,
    balance,           // موجب = المورد دائن علينا
    is_overdue:       false,
  };
}

// تحديث حالة القسط لو تجاوز تاريخ الاستحقاق
async function syncInstallmentStatuses(db_run) {
  await db_run(`
    UPDATE payment_installments
    SET status = 'overdue'
    WHERE status = 'pending'
      AND due_date < date('now')
      AND paid_amount < amount
  `);
}

module.exports = { getSupplierBalance, syncInstallmentStatuses };