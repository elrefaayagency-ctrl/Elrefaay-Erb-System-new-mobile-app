// notifications/messages.js
// ─── قوالب رسائل تيليجرام — دوال نقية بحتة (بيانات تدخل، نص يخرج) ───
// محدش هنا بيتكلم مع قاعدة بيانات ولا API؛ الملف ده مسؤوليته الوحيدة هي
// الصياغة والتنسيق. أي منطق حساب (هل المنتج فعلاً منخفض المخزون؟ هل القسط
// فعلاً متأخر؟) بيتعمل في مكانه الأصلي (stockAlerts.js، installmentEngine.js)
// ومبيتكررش هنا أبداً — الرسائل هنا بتعرض نتائج جاهزة بس.

const { fmt, fmtDate } = require('./telegramNotifier');
const SEP = '─'.repeat(30);

const payTypeLabel = { cash: 'نقداً', credit: 'آجل', installment: 'تقسيط' };
const payMethodLabel = { cash: 'نقدي', bank_transfer: 'تحويل بنكي', cheque: 'شيك', vodafone_cash: 'فودافون كاش', instapay: 'إنستاباي', other: 'أخرى' };

function approxMonthsBetween(d1, d2) {
  const a = new Date(d1), b = new Date(d2);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

function buildInstallmentBlock(installments) {
  if (!Array.isArray(installments) || !installments.length) return '';
  const sorted = [...installments].sort((a, b) => a.installment_number - b.installment_number);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const months = approxMonthsBetween(first.due_date, last.due_date);
  let block = `${SEP}\n📆 <b>تفاصيل التقسيط:</b>\n`;
  block += `  • عدد الأقساط: <b>${sorted.length}</b> قسط\n`;
  if (months !== null) block += `  • مدة التقسيط: <b>~${months}</b> شهر تقريباً\n`;
  block += `  • أول قسط: <b>${fmt(first.amount)} ج.م</b> — استحقاقه ${fmtDate(first.due_date)}\n`;
  if (sorted.length > 1) block += `  • آخر قسط: <b>${fmt(last.amount)} ج.م</b> — استحقاقه ${fmtDate(last.due_date)}\n`;
  return block;
}

// ═══ الفواتير ═══
const INVOICE_HEADERS = {
  draft: '📝 <b>فاتورة جديدة — محفوظة كمسودة</b>\n<i>(بانتظار التأكيد النهائي ولم يُخصم المخزون بعد)</i>',
  confirmed: '✅ <b>تم تأكيد الفاتورة وخصم الكمية من المخزون</b>',
  cancelled: '❌ <b>تم إلغاء الفاتورة</b>',
};

function invoiceMessage({ invoice, items, installments, eventType, actorName }) {
  const header = INVOICE_HEADERS[eventType] || INVOICE_HEADERS[invoice.status] || '📄 <b>فاتورة</b>';
  const balanceDue = (invoice.total || 0) - (invoice.paid_amount || 0);
  const itemsText = (items || []).map(it => `  • ${it.product_name} — ${it.quantity} × ${fmt(it.unit_price)} = <b>${fmt(it.line_total)} ج.م</b>`).join('\n');

  let msg = `${header}\n${SEP}\n`;
  msg += `🧾 <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n`;
  msg += `👤 <b>العميل:</b> ${invoice.customer_name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(invoice.invoice_date)}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `💳 <b>نوع الدفع:</b> ${payTypeLabel[invoice.payment_type] || invoice.payment_type || '—'}\n`;
  if (invoice.location_name) msg += `🏪 <b>الفرع/الموقع:</b> ${invoice.location_name}\n`;
  msg += `${SEP}\n`;
  if (itemsText) msg += `🛒 <b>المنتجات:</b>\n${itemsText}\n${SEP}\n`;
  msg += `💰 <b>الإجمالي: ${fmt(invoice.total)} ج.م</b>\n`;
  if (invoice.paid_amount > 0) msg += `✅ <b>المدفوع: ${fmt(invoice.paid_amount)} ج.م</b>\n`;
  if (balanceDue > 0 && eventType !== 'cancelled') msg += `⚠️ <b>المتبقي: ${fmt(balanceDue)} ج.م</b>\n`;
  if (invoice.payment_type === 'credit' && invoice.due_date) msg += `${SEP}\n📌 <b>تاريخ استحقاق الأجل:</b> ${fmtDate(invoice.due_date)}\n`;
  if (invoice.payment_type === 'installment' && eventType !== 'cancelled') msg += buildInstallmentBlock(installments);
  return msg;
}

// ═══ دفعة عميل ═══
function customerPaymentMessage({ payment, customer, invoice, actorName }) {
  let msg = `💰 <b>تم تحصيل دفعة من العميل</b>\n${SEP}\n`;
  msg += `🧾 <b>رقم الإيصال:</b> <code>${payment.payment_number}</code>\n`;
  msg += `👤 <b>العميل:</b> ${customer?.name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(payment.payment_date)}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `💳 <b>طريقة الدفع:</b> ${payMethodLabel[payment.payment_method] || payment.payment_method || '—'}\n`;
  msg += `${SEP}\n💵 <b>المبلغ المحصّل: ${fmt(payment.amount)} ج.م</b>\n`;
  if (invoice) {
    const remaining = (invoice.total || 0) - (invoice.paid_amount || 0);
    msg += `${SEP}\n🧾 <b>مرتبطة بالفاتورة:</b> <code>${invoice.invoice_number}</code>\n`;
    msg += remaining > 0 ? `⚠️ <b>المتبقي على الفاتورة:</b> ${fmt(remaining)} ج.م\n` : `🎉 <b>تم سداد الفاتورة بالكامل</b>\n`;
  }
  if (payment.reference) msg += `📎 <b>مرجع:</b> ${payment.reference}\n`;
  return msg;
}

// ═══ دفعة مورد ═══
function supplierPaymentMessage({ payment, supplier, po, actorName }) {
  let msg = `💸 <b>تم تسجيل دفعة لمورد</b>\n${SEP}\n`;
  msg += `🧾 <b>رقم الدفعة:</b> <code>${payment.payment_number}</code>\n`;
  msg += `🏭 <b>المورد:</b> ${supplier?.name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(payment.payment_date)}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `💳 <b>طريقة الدفع:</b> ${payMethodLabel[payment.payment_method] || payment.payment_method || '—'}\n`;
  msg += `${SEP}\n💵 <b>المبلغ: ${fmt(payment.amount)} ج.م</b>\n`;
  if (po) {
    const remaining = (po.total || 0) - (po.paid_amount || 0);
    msg += `${SEP}\n📦 <b>مرتبطة بأمر الشراء:</b> <code>${po.po_number}</code>\n`;
    msg += remaining > 0 ? `⚠️ <b>المتبقي على الأمر:</b> ${fmt(remaining)} ج.م\n` : `🎉 <b>تم سداد الأمر بالكامل</b>\n`;
  }
  if (payment.reference) msg += `📎 <b>مرجع:</b> ${payment.reference}\n`;
  return msg;
}

// ═══ المنتجات ═══
function productMessage({ product, eventType, actorName }) {
  const headers = { created: '🆕 <b>منتج جديد</b>', updated: '✏️ <b>تم تعديل منتج</b>', deleted: '🗑️ <b>تم حذف منتج</b>' };
  let msg = `${headers[eventType] || '📦 <b>منتج</b>'}\n${SEP}\n`;
  msg += `📦 <b>المنتج:</b> ${product.name}\n`;
  msg += `🔖 <b>SKU:</b> <code>${product.sku || '—'}</code>\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  if (eventType !== 'deleted') {
    msg += `💰 <b>سعر البيع:</b> ${fmt(product.sale_price)} ج.م\n`;
  }
  return msg;
}

// ═══ المخزون المنخفض ═══
function lowStockMessage({ product }) {
  const isOut = product.total_quantity <= 0;
  let msg = `${isOut ? '🚨 <b>نفاد مخزون</b>' : '⚠️ <b>تنبيه مخزون منخفض</b>'}\n${SEP}\n`;
  msg += `📦 <b>المنتج:</b> ${product.name}\n🔖 <b>SKU:</b> <code>${product.sku || '—'}</code>\n`;
  if (product.low_stock_mode === 'per_location' && product.low_locations?.length) {
    msg += `${SEP}\n📍 <b>المخازن المتأثرة:</b>\n`;
    product.low_locations.forEach(l => { msg += `  • ${l.location_name}: <b>${l.quantity}</b> (حد التنبيه ${l.threshold})\n`; });
  } else {
    msg += `📊 <b>الكمية الحالية:</b> ${fmt(product.total_quantity)} — <b>حد التنبيه:</b> ${fmt(product.min_stock_threshold)}\n`;
  }
  return msg;
}

// ═══ أمر شراء ═══
function poMessage({ order, items, eventType, actorName }) {
  const headers = { created: '🆕 <b>أمر شراء جديد</b>', delayed: '⏰ <b>أمر شراء متأخر التوريد</b>' };
  let msg = `${headers[eventType] || '📦 <b>أمر شراء</b>'}\n${SEP}\n`;
  msg += `📦 <b>رقم الأمر:</b> <code>${order.po_number}</code>\n`;
  msg += `🏭 <b>المورد:</b> ${order.supplier_name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(order.order_date)}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `💳 <b>نوع الشراء:</b> ${order.purchase_type === 'installment' ? 'تقسيط' : 'نقدي'}\n`;
  if (eventType === 'delayed') {
    const days = Math.floor((Date.now() - new Date(order.expected_date).getTime()) / 86400000);
    msg += `${SEP}\n⏰ <b>تاريخ التوريد المتوقع:</b> ${fmtDate(order.expected_date)}\n`;
    msg += `🔴 <b>متأخر منذ:</b> ${days} يوم\n`;
  } else if (items?.length) {
    msg += `${SEP}\n🛒 <b>البنود:</b>\n` + items.map(it => `  • ${it.product_name} — ${it.qty_ordered} × ${fmt(it.unit_cost)}`).join('\n') + '\n';
  }
  msg += `${SEP}\n💰 <b>الإجمالي: ${fmt(order.total)} ج.م</b>\n`;
  return msg;
}

// ═══ استلام بضاعة ═══
function goodsReceiptMessage({ receipt, actorName }) {
  let msg = `📥 <b>تم استلام بضاعة</b>\n${SEP}\n`;
  msg += `🧾 <b>رقم الإيصال:</b> <code>${receipt.receipt_number}</code>\n`;
  msg += `🏭 <b>المورد:</b> ${receipt.supplier_name || '—'}\n`;
  msg += `📦 <b>أمر الشراء:</b> <code>${receipt.po_number || '—'}</code>\n`;
  msg += `🏬 <b>المخزن:</b> ${receipt.location_name || '—'}\n`;
  msg += `👤 <b>استلم بواسطة:</b> ${actorName || receipt.received_by || '—'}\n`;
  return msg;
}

// ═══ قسط مستحق قريباً / متأخر (عميل أو مورد) ═══
function installmentReminderMessage({ entityType, installment, accountName, docNumber, eventType }) {
  const isCustomer = entityType === 'customer';
  const headers = {
    upcoming: `⏳ <b>قسط ${isCustomer ? 'عميل' : 'مورد'} مستحق قريباً</b>`,
    overdue: `🔴 <b>قسط ${isCustomer ? 'عميل' : 'مورد'} متأخر</b>`,
  };
  const remaining = (installment.amount || 0) - (installment.paid_amount || 0);
  let msg = `${headers[eventType]}\n${SEP}\n`;
  msg += `${isCustomer ? '👤' : '🏭'} <b>${isCustomer ? 'العميل' : 'المورد'}:</b> ${accountName || '—'}\n`;
  msg += `🧾 <b>${isCustomer ? 'الفاتورة' : 'أمر الشراء'}:</b> <code>${docNumber || '—'}</code>\n`;
  msg += `📅 <b>تاريخ الاستحقاق:</b> ${fmtDate(installment.due_date)}\n`;
  msg += `💰 <b>المبلغ المتبقي:</b> ${fmt(remaining)} ج.م\n`;
  return msg;
}

// ═══ تغييرات إعدادات مهمة ═══
function settingsChangedMessage({ actorName, changedFields }) {
  let msg = `⚙️ <b>تم تعديل إعدادات النظام</b>\n${SEP}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  if (changedFields?.length) msg += `📝 <b>الحقول المعدّلة:</b> ${changedFields.join('، ')}\n`;
  return msg;
}

// ═══ تسوية مخزون يدوية ═══
function inventoryAdjustedMessage({ product, location_name, movement_type, quantity_before, quantity_after, notes, actorName }) {
  const typeLabel = { in: 'إضافة', out: 'خصم', adjustment: 'تسوية مطلقة' };
  let msg = `🔧 <b>تعديل مخزون يدوي</b>\n${SEP}\n`;
  msg += `📦 <b>المنتج:</b> ${product.name}\n🏬 <b>المخزن:</b> ${location_name || '—'}\n`;
  msg += `🔄 <b>نوع الحركة:</b> ${typeLabel[movement_type] || movement_type}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `${SEP}\n📊 <b>الكمية:</b> ${fmt(quantity_before)} ← <b>${fmt(quantity_after)}</b>\n`;
  if (notes) msg += `📝 ${notes}\n`;
  return msg;
}

// ═══ تحويل مخزون بين مخازن ═══
function stockTransferMessage({ transfer, items, fromLocation, toLocation, actorName }) {
  let msg = `🔀 <b>تحويل مخزون بين مخازن</b>\n${SEP}\n`;
  msg += `🧾 <b>رقم التحويل:</b> <code>${transfer.transfer_number}</code>\n`;
  msg += `📤 <b>من:</b> ${fromLocation || '—'}   📥 <b>إلى:</b> ${toLocation || '—'}\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  if (items?.length) {
    msg += `${SEP}\n🛒 <b>الأصناف:</b>\n` + items.map(it => `  • ${it.product_name} — ${it.quantity}`).join('\n') + '\n';
  }
  return msg;
}

// ═══ مرتجعات المبيعات ═══
const returnTypeLabel = { refund: 'استرداد نقدي', exchange: 'استبدال', repair: 'إصلاح', store_credit: 'رصيد مرتجعات' };
function salesReturnMessage({ ret, eventType, actorName }) {
  const headers = { created: '↩️ <b>طلب مرتجع مبيعات جديد</b>', completed: '✅ <b>تم إتمام مرتجع مبيعات</b>' };
  let msg = `${headers[eventType] || '↩️ <b>مرتجع مبيعات</b>'}\n${SEP}\n`;
  msg += `🧾 <b>رقم المرتجع:</b> <code>${ret.return_number}</code>\n`;
  msg += `👤 <b>العميل:</b> ${ret.customer_name || '—'}\n`;
  msg += `📄 <b>الفاتورة الأصلية:</b> <code>${ret.invoice_number || '—'}</code>\n`;
  if (actorName) msg += `👨‍💼 <b>بواسطة:</b> ${actorName}\n`;
  msg += `🔄 <b>النوع:</b> ${returnTypeLabel[ret.return_type] || ret.return_type}\n`;
  msg += `${SEP}\n💰 <b>القيمة:</b> ${fmt(ret.total_refund)} ج.م\n`;
  if (ret.return_type === 'repair' && ret.expected_return_date) {
    msg += `📅 <b>موعد استرجاع المنتج للعميل:</b> ${fmtDate(ret.expected_return_date)}\n`;
  }
  if (ret.reason) msg += `📝 <b>السبب:</b> ${ret.reason}\n`;
  return msg;
}

module.exports = {
  invoiceMessage, customerPaymentMessage, supplierPaymentMessage,
  productMessage, lowStockMessage, poMessage, goodsReceiptMessage,
  installmentReminderMessage, settingsChangedMessage,
  inventoryAdjustedMessage, stockTransferMessage,
  salesReturnMessage,
};
