// utils/eventBus.js
// ─── ناقل الأحداث المركزي ───
// الموديولات التجارية (منتجات، فواتير، مشتريات، مدفوعات...) بتنشر حدث هنا
// بس (`eventBus.emit('invoice.created', {...})`) — ومش عارفة ولا مفروض
// تعرف حاجة عن تيليجرام أو أي قناة تنبيه تانية خالص. مين اللي بيسمع
// الحدث ده وبيعمل بيه إيه (يبعت تيليجرام؟ إيميل؟ واتساب لاحقاً؟) بالكامل
// مسؤولية طبقة التنبيهات (src/notifications/) اللي بتسجل مستمعين على نفس
// الناقل ده — فصل تام بين منطق العمل ومنطق الإشعارات.
//
// ليه EventEmitter عادي من Node بدل مكتبة خارجية؟ لأن الاستخدام هنا كله
// داخل نفس العملية (in-process)، مفيش حاجة لـ queue خارجي أو broker —
// EventEmitter كافي تماماً وصفري تبعيات إضافية.

const EventEmitter = require('events');

class AppEventBus extends EventEmitter {}

const eventBus = new AppEventBus();

// أي استثناء يطلع من مستمع (listener) ما ينفعش يوقف أو يكسر الطلب اللي
// نشر الحدث أصلاً — الإشعارات دايماً "best effort"، مش جزء من نجاح العملية.
eventBus.on('error', (err) => {
  console.error('[EventBus] خطأ في أحد المستمعين:', err?.message || err);
});

module.exports = eventBus;
