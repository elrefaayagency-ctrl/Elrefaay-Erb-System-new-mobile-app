// utils/logger.js
// ─── Logger بسيط بصيغة JSON منظّمة (structured logging) ───
// المشروع مستضاف عادة على Railway/Docker حيث كل الاستضافات القياسية
// بتلتقط stdout/stderr تلقائياً كـ logs (مفيش داعي لمكتبة خارجية زي winston
// أو ملفات log على القرص). المطلوب فعلياً بس إن كل سطر log يبقى JSON منظّم
// (وقت + مستوى + رسالة + بيانات إضافية) عشان يبقى قابل للفلترة والبحث في
// أي منصة مراقبة (Railway logs, Datadog, ELK...) بدل نص حر غير منظّم.
// ما زال بيطبع على console.* عادي (نفس السلوك من ناحية الالتقاط)، بس بشكل
// قابل للقراءة الآلية.

function baseLine(level, message, meta) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  });
}

function info(message, meta) {
  console.log(baseLine('info', message, meta));
}

function warn(message, meta) {
  console.warn(baseLine('warn', message, meta));
}

function error(message, meta) {
  console.error(baseLine('error', message, meta));
}

module.exports = { info, warn, error };
