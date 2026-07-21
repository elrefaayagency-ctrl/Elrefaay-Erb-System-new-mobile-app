// utils/sequenceGenerator.js
//
// ── مشكلة كانت موجودة في كل مولّد أرقام مستندات بالنظام (فاتورة، مورد، عميل،
//    أمر شراء، تحويل مخزني، إذن استلام، مرتجع، دفعة، مصروف...):
//    كل واحد منهم كان بيعمل SELECT COUNT(*) FROM table ثم يجمع 1 على النتيجة.
//    ده مش آمن إطلاقاً تحت أي تزامن حقيقي: لو مستخدمين بعتوا طلبين لإنشاء
//    فاتورة في نفس اللحظة (فرق مايكروثانية)، الاتنين ممكن ياخدوا نفس الـ COUNT
//    قبل ما أي منهم يخلّص الـ INSERT، فيتولّد لهم نفس رقم الفاتورة بالظبط.
//    في أفضل الأحوال (لو عمود الرقم عليه UNIQUE) الطلب التاني هيفشل بخطأ قاعدة
//    بيانات غامض للمستخدم. في أسوأ الأحوال (لو مفيش UNIQUE) هيتخزن رقمين
//    مستندين مختلفين بنفس الرقم — كارثة في نظام مالي (تضارب في الأرشفة
//    والتقارير والمطابقة مع العميل/المورد).
//
//    الحل: استخدام SEQUENCE من Postgres. الـ nextval() عملية ذرية (atomic)
//    مضمونة من قاعدة البيانات نفسها حتى تحت آلاف الطلبات المتزامنة، من غير
//    أي قفل (lock) يدوي أو انتظار. ملحوظة: ممكن يحصل "فجوة" بسيطة في الترقيم
//    لو حصل rollback لمعاملة بعد أخد الرقم (نفس سلوك أغلب أنظمة الفوترة
//    المعروفة عالمياً — الأولوية لسلامة البيانات مش لتسلسل الأرقام بدون فجوات).
//
//    مهم: بما إن قاعدة البيانات دي شغّالة فعلياً وفيها بيانات حقيقية، أول مرة
//    نُنشئ فيها كل SEQUENCE بنحدد نقطة البداية بناءً على آخر رقم موجود فعلاً
//    (عبر computeStartAt) بدل ما نبدأ من 1 ونصطدم بأرقام مستخدمة قبل كده.
const { run, get } = require('../db/database');

const ensuredSequences = new Set();

// ── computeStartAt: دالة async اختيارية بترجع رقم البداية، بتتنفذ *مرة واحدة فقط*
//    طول عمر السيرفر (أول استخدام)، وقت إنشاء الـ SEQUENCE الفعلي فقط ──
async function nextDocumentNumber(seqName, prefix, padLength = 5, computeStartAt = null) {
  if (!ensuredSequences.has(seqName)) {
    const startAt = computeStartAt ? await computeStartAt() : 1;
    await run(`CREATE SEQUENCE IF NOT EXISTS ${seqName} START WITH ${Math.max(1, startAt)}`);
    ensuredSequences.add(seqName);
  }
  const row = await get(`SELECT nextval('${seqName}') as n`);
  return `${prefix}-${String(row.n).padStart(padLength, '0')}`;
}

module.exports = { nextDocumentNumber };
