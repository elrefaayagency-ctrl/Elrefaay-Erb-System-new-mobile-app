// jobs/reconcileInstallments.js
// ─── مصالحة تاريخية لأقساط اتأثرت بباج قديم ───
// قبل إصلاح customerPayments.js/supplierPayments.js، أي دفعة عامة على
// فاتورة/أمر تقسيط من غير تحديد قسط بعينه كانت بتحدّث "المدفوع" على
// الفاتورة/الأمر ذاته، لكن صفوف الأقساط الفردية كانت تفضل معلّقة زي ما
// هي للأبد. الدالة دي بتصالح الفرق: بتحسب "مبلغ مدفوع فعلياً على المستند
// لكن لسه مش موزّع على أي قسط" وتوزّعه بنفس منطق FIFO المستخدم وقت
// التشغيل العادي. آمنة تماماً تتكرر أي عدد مرات (idempotent) — لو مفيش
// فرق غير موزّع، مش هتعمل حاجة.

const { all, get, run, transaction } = require('../db/database');
const { allocatePaymentFIFO } = require('../utils/installmentEngine');

async function reconcileEntity(entityType) {
  const isCustomer = entityType === 'customer';
  const table = isCustomer ? 'customer_installments' : 'payment_installments';
  const parentTable = isCustomer ? 'invoices' : 'purchase_orders';
  const parentFk = isCustomer ? 'invoice_id' : 'po_id';
  const parentTypeCol = isCustomer ? 'payment_type' : 'purchase_type';

  const docs = await all(`
    SELECT id, paid_amount FROM ${parentTable}
    WHERE ${parentTypeCol} = 'installment' AND paid_amount > 0
  `);

  let fixedCount = 0;
  for (const doc of docs) {
    const installments = await all(`SELECT * FROM ${table} WHERE ${parentFk} = ?`, [doc.id]);
    if (!installments.length) continue;

    const allocatedSoFar = installments.reduce((s, i) => s + Number(i.paid_amount || 0), 0);
    const unallocated = Math.round((doc.paid_amount - allocatedSoFar) * 100) / 100;
    if (unallocated <= 0.01) continue; // مفيش فرق يستاهل — الحالة سليمة أصلاً

    const pending = installments.filter(i => i.status !== 'paid');
    if (!pending.length) continue;

    const { allocations } = allocatePaymentFIFO(pending, unallocated);
    if (!allocations.length) continue;

    await transaction(async () => {
      for (const a of allocations) {
        await run(`UPDATE ${table} SET paid_amount=?, status=?, updated_at=datetime('now') WHERE id=?`,
          [a.newPaid, a.newStatus, a.id]);
      }
    });
    fixedCount++;
  }
  return fixedCount;
}

async function runInstallmentReconciliation() {
  try {
    const customerFixed = await reconcileEntity('customer');
    const supplierFixed = await reconcileEntity('supplier');
    if (customerFixed || supplierFixed) {
      console.log(`✓ مصالحة الأقساط: تم تصحيح ${customerFixed} فاتورة عميل و${supplierFixed} أمر شراء مورد كانت أقساطهم غير متزامنة مع المدفوعات الفعلية`);
    }
  } catch (err) {
    console.error('✗ فشلت مصالحة الأقساط:', err.message);
  }
}

module.exports = { runInstallmentReconciliation };
