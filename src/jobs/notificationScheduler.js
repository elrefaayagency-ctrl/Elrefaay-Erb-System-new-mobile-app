// jobs/notificationScheduler.js
// ─── الفحص الدوري للتنبيهات (المرحلة 7) ───
// الملف ده مش بيحسب أي حاجة بنفسه — كل فحص بيستخدم نفس المحرك الموحّد
// اللي اتبنى في مراحل سابقة (installmentEngine، stockAlerts) وبينشر
// النتيجة كحدث على eventBus بس. الحماية من تكرار نفس التنبيه (dedup)
// موجودة في طبقة الإرسال نفسها (telegramNotifier.sendTextOnce)، مش هنا.

const { get, all } = require('../db/database');
const eventBus = require('../utils/eventBus');
const { getAllLowStockProducts } = require('../utils/stockAlerts');
const { getUpcomingAndOverdueInstallments } = require('../utils/installmentEngine');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // كل ساعة — كافي جداً لتنبيهات يومية الطابع، وبيقلل الحمل على القاعدة

async function checkLowStock() {
  const lowStockItems = await getAllLowStockProducts(); // من غير فلتر مواقع — الفحص الدوري نطاقه كل الشركة
  for (const product of lowStockItems) {
    eventBus.emit('inventory.low_stock', { product });
  }
}

async function checkInstallments(entityType) {
  const settings = await get(`SELECT installment_reminder_days FROM settings WHERE id=1`);
  const reminderDays = settings?.installment_reminder_days ?? 1;

  const { overdue, upcoming } = await getUpcomingAndOverdueInstallments(entityType, reminderDays);

  overdue.forEach(inst => eventBus.emit('installment.reminder', {
    entityType, installment: inst, accountName: inst.account_name, docNumber: inst.doc_number, eventType: 'overdue',
  }));
  upcoming.forEach(inst => eventBus.emit('installment.reminder', {
    entityType, installment: inst, accountName: inst.account_name, docNumber: inst.doc_number, eventType: 'upcoming',
  }));
}

async function checkDelayedPurchaseOrders() {
  const delayed = await all(`
    SELECT po.*, s.name as supplier_name
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    WHERE po.status IN ('sent','partial')
      AND po.expected_date IS NOT NULL
      AND po.expected_date < date('now')
  `);
  delayed.forEach(order => eventBus.emit('purchase_order.delayed', { order: { ...order, supplier_name: order.supplier_name } }));
}

async function runAllChecks() {
  const settings = await get(`SELECT notifications_enabled, notify_low_stock FROM settings WHERE id=1`);
  if (settings && !settings.notifications_enabled) return; // الإشعارات متوقفة كلياً من الإعدادات

  const tasks = [
    checkInstallments('customer'),
    checkInstallments('supplier'),
    checkDelayedPurchaseOrders(),
  ];
  if (!settings || settings.notify_low_stock) tasks.push(checkLowStock());

  const results = await Promise.allSettled(tasks);
  results.forEach(r => { if (r.status === 'rejected') console.error('[Scheduler] فشل أحد الفحوصات الدورية:', r.reason?.message || r.reason); });
}

let intervalHandle = null;

function startNotificationScheduler() {
  if (intervalHandle) return; // منع بدء أكتر من نسخة لو السيرفر عمل reload
  console.log('✓ جدولة فحوصات التنبيهات الدورية بدأت (كل ساعة)');
  // أول فحص بعد دقيقة من الإقلاع (مش فوراً، عشان نديله وقت DB يخلص كل الترحيلات)
  setTimeout(() => runAllChecks().catch(e => console.error('[Scheduler] خطأ:', e.message)), 60 * 1000);
  intervalHandle = setInterval(() => runAllChecks().catch(e => console.error('[Scheduler] خطأ:', e.message)), CHECK_INTERVAL_MS);
}

module.exports = { startNotificationScheduler, runAllChecks };
