// utils/telegram.js
// إرسال إشعارات إلى مجموعة تيليجرام عبر بوت (فاتورة جديدة / تأكيد فاتورة / تحصيل دفعة)
// الإعدادات (Token + Chat ID) تُقرأ من ملف .env في جذر المشروع:
//   TELEGRAM_BOT_TOKEN=...
//   TELEGRAM_CHAT_ID=...
// لو الإعدادات غير موجودة، يتم تجاهل الإرسال بدون التأثير على عملية الفاتورة.

const payTypeLabel = { cash: 'نقداً', credit: 'آجل', installment: 'تقسيط', mixed: 'مختلط' };

function fmt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return d;
  }
}

// عدد الأشهر التقريبي بين تاريخين (لاستخدامه في وصف "مدة التقسيط")
function approxMonthsBetween(d1, d2) {
  const a = new Date(d1), b = new Date(d2);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

// ─── عناوين احترافية مميزة لكل نوع حدث — لتجنب أي لخبطة بين الرسائل ───
const EVENT_HEADERS = {
  draft: '📝 <b>فاتورة جديدة — محفوظة كمسودة</b>\n<i>(بانتظار التأكيد النهائي ولم يُخصم المخزون بعد)</i>',
  confirmed: '✅ <b>تم تأكيد الفاتورة وخصم الكمية من المخزون</b>',
  cancelled: '❌ <b>تم إلغاء الفاتورة</b>',
};

function buildInstallmentBlock(installments, sep) {
  if (!Array.isArray(installments) || !installments.length) return '';
  const sorted = [...installments].sort((a, b) => a.installment_number - b.installment_number);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const months = approxMonthsBetween(first.due_date, last.due_date);

  let block = `${sep}\n`;
  block += `📆 <b>تفاصيل التقسيط:</b>\n`;
  block += `  • عدد الأقساط: <b>${sorted.length}</b> قسط\n`;
  if (months !== null) block += `  • مدة التقسيط: <b>~${months}</b> شهر تقريباً\n`;
  block += `  • أول قسط: <b>${fmt(first.amount)} ج.م</b> — استحقاقه ${fmtDate(first.due_date)}\n`;
  if (sorted.length > 1) {
    block += `  • آخر قسط: <b>${fmt(last.amount)} ج.م</b> — استحقاقه ${fmtDate(last.due_date)}\n`;
  }
  return block;
}

function buildInvoiceMessage(invoice, items, installments, eventType) {
  const sep = '─'.repeat(30);
  const header = EVENT_HEADERS[eventType] || EVENT_HEADERS[invoice.status] || '📄 <b>فاتورة — الرفاعي للنجف والإضاءة</b>';
  const balanceDue = (invoice.total || 0) - (invoice.paid_amount || 0);

  const itemsText = (items || [])
    .map((it) => `  • ${it.product_name} — ${it.quantity} × ${fmt(it.unit_price)} = <b>${fmt(it.line_total)} ج.م</b>`)
    .join('\n');

  let msg = `${header}\n`;
  msg += `<b>الرفاعي للنجف والإضاءة</b>\n`;
  msg += `${sep}\n`;
  msg += `🧾 <b>رقم الفاتورة:</b> <code>${invoice.invoice_number}</code>\n`;
  msg += `👤 <b>العميل:</b> ${invoice.customer_name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(invoice.invoice_date)}\n`;
  msg += `💳 <b>نوع الدفع:</b> ${payTypeLabel[invoice.payment_type] || invoice.payment_type || '—'}\n`;
  if (invoice.location_name) msg += `🏪 <b>الفرع/الموقع:</b> ${invoice.location_name}\n`;
  msg += `${sep}\n`;
  if (itemsText) msg += `🛒 <b>المنتجات:</b>\n${itemsText}\n${sep}\n`;
  msg += `💰 <b>الإجمالي: ${fmt(invoice.total)} ج.م</b>\n`;
  if (invoice.paid_amount > 0) msg += `✅ <b>المدفوع: ${fmt(invoice.paid_amount)} ج.م</b>\n`;
  if (balanceDue > 0) msg += `⚠️ <b>المتبقي: ${fmt(balanceDue)} ج.م</b>\n`;

  // تفاصيل البيع الآجل (بدون تقسيط)
  if (invoice.payment_type === 'credit' && invoice.due_date) {
    msg += `${sep}\n`;
    msg += `📌 <b>تاريخ استحقاق الأجل:</b> ${fmtDate(invoice.due_date)}\n`;
  }

  // تفاصيل التقسيط الكاملة
  if (invoice.payment_type === 'installment') {
    msg += buildInstallmentBlock(installments, sep);
  }

  return msg;
}

// ─── رسالة تحصيل دفعة ───
function buildPaymentMessage(payment, customer, invoice) {
  const sep = '─'.repeat(30);
  const payMethodLabel = { cash: 'نقدي', bank_transfer: 'تحويل بنكي', card: 'بطاقة', cheque: 'شيك' };

  let msg = `💰 <b>تم تحصيل دفعة من العميل</b>\n`;
  msg += `<b>الرفاعي للنجف والإضاءة</b>\n`;
  msg += `${sep}\n`;
  msg += `🧾 <b>رقم الإيصال:</b> <code>${payment.payment_number}</code>\n`;
  msg += `👤 <b>العميل:</b> ${customer?.name || '—'}\n`;
  msg += `📅 <b>التاريخ:</b> ${fmtDate(payment.payment_date)}\n`;
  msg += `💳 <b>طريقة الدفع:</b> ${payMethodLabel[payment.payment_method] || payment.payment_method || '—'}\n`;
  msg += `${sep}\n`;
  msg += `💵 <b>المبلغ المحصّل: ${fmt(payment.amount)} ج.م</b>\n`;

  if (invoice) {
    const remaining = (invoice.total || 0) - (invoice.paid_amount || 0);
    msg += `${sep}\n`;
    msg += `🧾 <b>مرتبطة بالفاتورة:</b> <code>${invoice.invoice_number}</code>\n`;
    msg += `💰 <b>إجمالي الفاتورة:</b> ${fmt(invoice.total)} ج.م\n`;
    msg += `✅ <b>إجمالي المدفوع حتى الآن:</b> ${fmt(invoice.paid_amount)} ج.م\n`;
    if (remaining > 0) msg += `⚠️ <b>المتبقي على الفاتورة:</b> ${fmt(remaining)} ج.م\n`;
    else msg += `🎉 <b>تم سداد الفاتورة بالكامل</b>\n`;
  }

  if (payment.reference) msg += `📎 <b>مرجع:</b> ${payment.reference}\n`;
  if (payment.notes) msg += `📝 ${payment.notes}\n`;

  return msg;
}

// ─── إرسال نص خام إلى تيليجرام — لا تُلقي استثناء أبداً ───
async function sendTelegramText(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID غير موجودين في .env — تم تجاهل الإشعار');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn('[Telegram] فشل إرسال الإشعار:', data.description);
    }
  } catch (err) {
    console.warn('[Telegram] خطأ في الاتصال بتيليجرام:', err.message);
  }
}

// eventType: 'draft' | 'confirmed' | 'cancelled'
async function sendInvoiceTelegramNotification(invoice, items, installments, eventType) {
  const message = buildInvoiceMessage(invoice, items, installments, eventType);
  await sendTelegramText(message);
}

async function sendPaymentTelegramNotification(payment, customer, invoice) {
  const message = buildPaymentMessage(payment, customer, invoice);
  await sendTelegramText(message);
}

module.exports = { sendInvoiceTelegramNotification, sendPaymentTelegramNotification };