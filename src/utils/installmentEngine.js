// utils/installmentEngine.js
// ─── محرك الأقساط الموحّد ───
// قبل هذا الملف كان نفس المنطق (توليد/فحص جدول الأقساط، تحديث المتأخر منها،
// إحصائيات اللوحة، وتطبيق الدفعة على القسط) مكرر في مكانين منفصلين تماماً:
// جانب العميل (customer_installments عبر invoices.js / customerInstallments.js
// / customerPayments.js) وجانب المورد (payment_installments عبر
// purchaseOrders.js / installments.js / supplierPayments.js) — وكانا مش
// متطابقين حتى: جانب العميل عنده تحقق صارم من جدول الأقساط، وجانب المورد
// معندوش أي تحقق خالص. وكمان الاتنين عندهم نفس الثغرة: تسديد قسط بعينه
// كان بيتقبل بأي مبلغ حتى لو أكبر من متبقي القسط نفسه.
//
// دلوقتي كل حاجة من دول بتمر من هنا مرة واحدة، ومطبّقة بالتساوي على الجانبين.

const { all, get, run } = require('../db/database');
const { round2 } = require('./money');

// إعدادات كل نوع كيان — الفرق الوحيد بين العميل والمورد هو أسماء
// الجداول/الأعمدة، مش منطق العمل نفسه.
const ENTITY_CONFIG = {
  customer: {
    table: 'customer_installments',
    accountIdCol: 'customer_id',
    parentIdCol: 'invoice_id',
    parentTable: 'invoices',
    parentAlias: 'inv',
    parentNumberCol: 'invoice_number',
    accountTable: 'customers',
    accountAlias: 'c',
  },
  supplier: {
    table: 'payment_installments',
    accountIdCol: 'supplier_id',
    parentIdCol: 'po_id',
    parentTable: 'purchase_orders',
    parentAlias: 'po',
    parentNumberCol: 'po_number',
    accountTable: 'suppliers',
    accountAlias: 's',
  },
};

function cfg(entityType) {
  const c = ENTITY_CONFIG[entityType];
  if (!c) throw new Error(`نوع كيان أقساط غير معروف: ${entityType}`);
  return c;
}

// ── فحص جدول الأقساط قبل الحفظ (مصدر حقيقة وحيد لكل من الفاتورة وأمر الشراء) ──
// كل قسط لازم يكون له مبلغ فعلي > 0 وتاريخ استحقاق، ومجموع الأقساط لازم
// يقارب إجمالي المستند (هامش 1 ج.م أو 1% أيهما أكبر، لفروق التقريب).
function validateInstallmentSchedule(installments, total) {
  if (!Array.isArray(installments) || installments.length === 0)
    return { error: 'لازم تحدد جدول أقساط' };
  for (const inst of installments) {
    if (!inst.amount || inst.amount <= 0 || !inst.due_date)
      return { error: 'كل قسط لازم يكون له مبلغ صحيح أكبر من صفر وتاريخ استحقاق' };
  }
  const sum = installments.reduce((s, i) => s + Number(i.amount || 0), 0);
  const tolerance = Math.max(1, total * 0.01);
  if (Math.abs(sum - total) > tolerance)
    return { error: `مجموع الأقساط (${sum.toFixed(2)} ج.م) لا يطابق الإجمالي (${total.toFixed(2)} ج.م) — تأكد من جدول الأقساط` };
  return null;
}

// ── تحديث حالة الأقساط المتأخرة (بديل موحّد لدالتين كانتا متطابقتين تقريباً) ──
async function syncOverdueInstallments(entityType, run_fn) {
  const { table } = cfg(entityType);
  await (run_fn || run)(`
    UPDATE ${table} SET status='overdue', updated_at=datetime('now')
    WHERE status='pending' AND due_date < date('now') AND paid_amount < amount
  `);
}

// ── إحصائيات لوحة التحكم (متأخر / مستحق قريباً / مسدد بالكامل) — موحّدة ──
async function getInstallmentDashboard(entityType) {
  const { table, accountTable, accountAlias, accountIdCol, parentTable, parentAlias, parentIdCol, parentNumberCol } = cfg(entityType);

  await syncOverdueInstallments(entityType);

  const overdue  = await get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM ${table} WHERE status='overdue'`);
  const upcoming = await get(`SELECT COUNT(*) as c, COALESCE(SUM(amount-paid_amount),0) as total FROM ${table} WHERE status='pending' AND due_date <= date('now','+30 days')`);
  const paid     = await get(`SELECT COUNT(*) as c, COALESCE(SUM(amount),0) as total FROM ${table} WHERE status='paid'`);

  const extraCol = entityType === 'customer' ? `, ${accountAlias}.phone as customer_phone` : '';
  const dueSoon = await all(`
    SELECT t.*, ${accountAlias}.name as ${entityType}_name, ${accountAlias}.code as ${entityType}_code${extraCol},
           ${parentAlias}.${parentNumberCol}
    FROM ${table} t
    JOIN ${accountTable} ${accountAlias} ON t.${accountIdCol} = ${accountAlias}.id
    ${entityType === 'customer' ? 'JOIN' : 'LEFT JOIN'} ${parentTable} ${parentAlias} ON t.${parentIdCol} = ${parentAlias}.id
    WHERE t.status IN ('pending','overdue')
    ORDER BY t.due_date ASC LIMIT ${entityType === 'customer' ? 15 : 10}
  `);

  return { overdue, upcoming, paid, due_soon: dueSoon };
}

// ── تطبيق دفعة على قسط محدد (منطق موحّد للعميل والمورد) ──
// مصدر الحقيقة الوحيد لسؤال: "لو دفعنا المبلغ ده على القسط ده، الحالة الجديدة إيه؟"
// وأهم حاجة: بيمنع أي مبلغ يتجاوز المتبقي الفعلي *على القسط نفسه* — الثغرة
// اللي كانت موجودة قبل كده في الجانبين (كان بيتحقق بس من متبقي الفاتورة/الأمر
// ككل، مش من متبقي القسط بعينه، فممكن قسط واحد ياخد فلوس أكتر من قيمته
// بينما أقساط تانية تفضل من غير تحصيل رغم وجود الفلوس أصلاً).
function computeInstallmentApplication(installment, paymentAmount) {
  const remaining = round2(installment.amount - installment.paid_amount);
  if (paymentAmount > remaining + 0.01) {
    return {
      error: `المبلغ المدخل (${paymentAmount.toFixed(2)} ج.م) أكبر من المتبقي على هذا القسط تحديداً (${remaining.toFixed(2)} ج.م)`,
    };
  }
  const newPaid = round2(installment.paid_amount + paymentAmount);
  const newStatus = newPaid >= installment.amount ? 'paid' : 'partial';
  return { newPaid, newStatus };
}

// ── إجمالي المستحق تراكمياً حتى تاريخ معين لكل حساب (عميل أو مورد) ──
// المصدر الوحيد لسؤال "المستحق فعلياً كأنك واقف في تاريخ كذا" — بيُستخدم
// في تقرير التحصيل بالمحافظة/المنطقة (المرحلة 6) بدل تكرار الاستعلام هناك.
// أي قسط استحقاقه <= التاريخ ولسه مش متسدد بالكامل بيتحسب، بغض النظر عن
// حالته المخزّنة حالياً (pending/overdue) لأن الحالة نفسها ممكن تكون لسه
// ماتحدّثتش — الحساب هنا بيعتمد على amount/paid_amount الفعليين مباشرة.
async function getDueAsOfDate(entityType, asOfDate) {
  const { table, accountIdCol } = cfg(entityType);
  return all(`
    SELECT ${accountIdCol} as account_id,
           COALESCE(SUM(amount - paid_amount), 0) as due_amount,
           COUNT(*) as installments_count,
           MIN(due_date) as earliest_due_date
    FROM ${table}
    WHERE due_date <= ? AND paid_amount < amount
    GROUP BY ${accountIdCol}
  `, [asOfDate]);
}

// ── الأقساط المستحقة قريباً/المتأخرة، مع بيانات الحساب والمستند — للجدولة
//    الدورية (src/jobs/notificationScheduler.js). التصنيف نفسه (قريب/متأخر)
//    منطق عمل، فلازم يعيش هنا في المحرك الموحّد مش في ملف الجدولة. ──
async function getUpcomingAndOverdueInstallments(entityType, reminderDays) {
  const { table, accountIdCol, accountTable, accountAlias, parentIdCol, parentTable, parentAlias, parentNumberCol } = cfg(entityType);

  const baseSelect = `
    SELECT t.*, ${accountAlias}.name as account_name, ${parentAlias}.${parentNumberCol} as doc_number
    FROM ${table} t
    JOIN ${accountTable} ${accountAlias} ON t.${accountIdCol} = ${accountAlias}.id
    ${entityType === 'customer' ? 'JOIN' : 'LEFT JOIN'} ${parentTable} ${parentAlias} ON t.${parentIdCol} = ${parentAlias}.id
    WHERE t.paid_amount < t.amount AND `;

  // ملحوظة مهمة: طبقة ترجمة SQL (database.js) بتتعرّف بس على الصيغة
  // الحرفية date('now','+N days') برقم ثابت جوه النص، مش على قيمة متغيرة
  // بعلامة استفهام أو ضم نصوص (|| ?). لازم نحقن الرقم مباشرة في الاستعلام
  // (بعد التأكد إنه رقم صحيح آمن)، مش نمرره كـ parameter عادي.
  const safeDays = Math.max(1, Math.min(90, parseInt(reminderDays, 10) || 1));

  const overdue = await all(`${baseSelect} t.due_date < date('now') ORDER BY t.due_date ASC`);
  const upcoming = await all(`${baseSelect} t.due_date >= date('now') AND t.due_date <= date('now','+${safeDays} days') ORDER BY t.due_date ASC`);

  return { overdue, upcoming };
}

// ── توزيع دفعة عامة (من غير قسط محدد) على الأقساط المستحقة تلقائياً،
//    الأقدم استحقاقاً أولاً (FIFO) ──
// المشكلة اللي بيحلّها: لو المستخدم سجّل دفعة على الفاتورة/الأمر ككل من
// غير ما يحدد قسط بعينه (زي "سدد كل المتبقي دفعة واحدة")، كان الفاتورة
// نفسها بتتحدث كمدفوعة بالكامل، لكن صفوف الأقساط الفردية كانت تفضل زي
// ما هي (pending) للأبد — تناقض واضح بين "الفاتورة مدفوعة" و"الأقساط
// لسه مستحقة" في شاشة متابعة الأقساط. الدالة دي هي نفس منطق التطبيق على
// قسط واحد (computeInstallmentApplication) بس مطبّق بالتتابع على كل
// الأقساط المتبقية لحد ما المبلغ يخلص.
function allocatePaymentFIFO(installments, paymentAmount) {
  let remaining = round2(paymentAmount);
  const allocations = [];
  const sorted = [...installments].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  for (const inst of sorted) {
    if (remaining <= 0.009) break;
    const instRemaining = round2(inst.amount - inst.paid_amount);
    if (instRemaining <= 0) continue;
    const applyAmount = round2(Math.min(remaining, instRemaining));
    const newPaid = round2(inst.paid_amount + applyAmount);
    const newStatus = newPaid >= inst.amount ? 'paid' : 'partial';
    allocations.push({ id: inst.id, applyAmount, newPaid, newStatus });
    remaining = round2(remaining - applyAmount);
  }
  return { allocations, unallocatedRemainder: remaining };
}

module.exports = {
  validateInstallmentSchedule,
  syncOverdueInstallments,
  getInstallmentDashboard,
  computeInstallmentApplication,
  getDueAsOfDate,
  getUpcomingAndOverdueInstallments,
  allocatePaymentFIFO,
};