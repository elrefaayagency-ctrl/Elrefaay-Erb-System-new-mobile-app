// notifications/listeners.js
// ─── الجسر الوحيد بين الأحداث التجارية وتيليجرام ───
// هنا بس بيتسجل مين بيسمع لأي حدث، وبيتقرر الرسالة المناسبة له. الموديولات
// التجارية (products.js، invoices.js، إلخ) معندهاش أي فكرة إن الملف ده
// موجود أصلاً — هي بس بتنشر حدث على eventBus وخلاص.
//
// لازم يتعمل require لهذا الملف *مرة واحدة* عند إقلاع السيرفر (من server.js)
// عشان يسجّل كل المستمعين قبل ما أي طلب يوصل.

const eventBus = require('../utils/eventBus');
const notifier = require('./telegramNotifier');
const messages = require('./messages');

// أي استثناء جوه أي مستمع بيتلقّط هنا ومحدش هيوقف لأجله — فشل إرسال
// إشعار واحد ما ينفعش يوقف السيرفر ولا يأثر على أي عملية تجارية.
function safeOn(event, handler) {
  eventBus.on(event, (payload) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch(err => console.error(`[Notifications] فشل معالجة حدث "${event}":`, err?.message || err));
  });
}

// ═══ الفواتير ═══
safeOn('invoice.created', async (p) => {
  await notifier.sendText(messages.invoiceMessage({ ...p, eventType: 'draft' }));
});
safeOn('invoice.confirmed', async (p) => {
  await notifier.sendText(messages.invoiceMessage({ ...p, eventType: 'confirmed' }));
});
safeOn('invoice.cancelled', async (p) => {
  await notifier.sendText(messages.invoiceMessage({ ...p, eventType: 'cancelled' }));
});

// ═══ المدفوعات ═══
safeOn('customer_payment.recorded', async (p) => {
  await notifier.sendText(messages.customerPaymentMessage(p));
});
safeOn('supplier_payment.recorded', async (p) => {
  await notifier.sendText(messages.supplierPaymentMessage(p));
});

// ═══ المنتجات ═══
safeOn('product.created', async (p) => {
  await notifier.sendText(messages.productMessage({ ...p, eventType: 'created' }));
});
safeOn('product.updated', async (p) => {
  await notifier.sendText(messages.productMessage({ ...p, eventType: 'updated' }));
});
safeOn('product.deleted', async (p) => {
  await notifier.sendText(messages.productMessage({ ...p, eventType: 'deleted' }));
});

// ═══ المشتريات ═══
safeOn('purchase_order.created', async (p) => {
  await notifier.sendText(messages.poMessage({ ...p, eventType: 'created' }));
});
safeOn('goods_receipt.created', async (p) => {
  await notifier.sendText(messages.goodsReceiptMessage(p));
});

// ═══ إعدادات النظام ═══
safeOn('settings.updated', async (p) => {
  await notifier.sendText(messages.settingsChangedMessage(p));
});

// ═══ حركات المخزون ═══
safeOn('inventory.adjusted', async (p) => {
  await notifier.sendText(messages.inventoryAdjustedMessage(p));
});
safeOn('stock.transferred', async (p) => {
  await notifier.sendText(messages.stockTransferMessage(p));
});

// ═══ مرتجعات المبيعات ═══
safeOn('sales_return.created', async (p) => {
  await notifier.sendText(messages.salesReturnMessage({ ...p, eventType: 'created' }));
});
safeOn('sales_return.completed', async (p) => {
  await notifier.sendText(messages.salesReturnMessage({ ...p, eventType: 'completed' }));
});

// ═══ أحداث دورية (من الجدولة — src/jobs/notificationScheduler.js) ═══
// هذول بيستخدموا sendTextOnce بدل sendText عشان الحماية من التكرار —
// نفس القسط المتأخر أو نفس المنتج منخفض المخزون ما يتبعتش أكتر من مرة
// في نفس اليوم حتى لو الفحص الدوري شغّال كل شوية.
safeOn('inventory.low_stock', async (p) => {
  const eventKey = `low_stock:${p.product.product_id}:${new Date().toISOString().split('T')[0]}`;
  await notifier.sendTextOnce(eventKey, 'inventory.low_stock', messages.lowStockMessage(p));
});

safeOn('purchase_order.delayed', async (p) => {
  const eventKey = `po_delayed:${p.order.id}:${new Date().toISOString().split('T')[0]}`;
  await notifier.sendTextOnce(eventKey, 'purchase_order.delayed', messages.poMessage({ order: p.order, eventType: 'delayed' }));
});

safeOn('installment.reminder', async (p) => {
  const eventKey = `installment_${p.eventType}:${p.entityType}:${p.installment.id}:${new Date().toISOString().split('T')[0]}`;
  await notifier.sendTextOnce(eventKey, `installment.${p.eventType}`, messages.installmentReminderMessage(p));
});

module.exports = eventBus; // مش لازم فعلياً، بس بيسهّل require هذا الملف لغرض "التسجيل" فقط
