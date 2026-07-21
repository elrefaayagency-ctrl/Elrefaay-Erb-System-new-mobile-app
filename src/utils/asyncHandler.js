// utils/asyncHandler.js
// كل توابع قاعدة البيانات بقت async بعد الانتقال لـ PostgreSQL، فأي خطأ
// (فشل اتصال، خرق قيد UNIQUE، إلخ) بيرجع كـ rejected Promise. Express 4
// (المستخدم في هذا المشروع) لا يلتقط تلقائياً الأخطاء من دوال async —
// لازم نلقطها يدوياً ونمررها لـ next(err) وإلا هيتعلق الطلب من غير رد
// (response) للمستخدم أبداً. هذا الـ wrapper يغلّف كل route handler عشان
// يضمن إن أي خطأ غير متوقع يوصل لمعالج الأخطاء العام في server.js.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
