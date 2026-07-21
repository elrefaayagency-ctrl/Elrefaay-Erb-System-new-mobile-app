# دليل قاعدة البيانات (Database Setup)

## المزوّد
PostgreSQL عبر Supabase (أو أي PostgreSQL ≥ 13 متوافق). لا يوجد أي كود
خاص بـ Supabase تحديدًا — أي connection string PostgreSQL عادي يشتغل.

## إعداد Supabase من الصفر
1. أنشئ مشروع جديد على supabase.com
2. Project Settings → Database → Connection string → انسخ نسخة "URI"
   (فيها الباسورد جاهز، أو اختر "Session pooler" لو السيرفر بياخد عدد
   اتصالات كبير)
3. الصقها في `.env` كـ `DATABASE_URL`

## المخطط (Schema) وكيفية إدارته
كل الجداول والـ migrations معرّفة في `src/db/schema.js`، ومتنفذة تلقائيًا
بترتيب محدد عند إقلاع السيرفر (`server.js` → `startServer()`). **لا
تحتاج أي أداة migration خارجية (Prisma, Knex, إلخ) ولا أي خطوة يدوية** —
كل شيء idempotent (`CREATE TABLE IF NOT EXISTS`, فحص وجود العمود قبل
`ALTER TABLE`)، فتشغيل السيرفر مرة أو مية مرة على نفس القاعدة له نفس
الأثر بالظبط.

**ترتيب التنفيذ (مهم — تم إصلاحه في Stage 5):**
```
createSchema() → createProcurementSchema() → createSalesSchema() →
createPhase4Schema() → [كل الـ migrate* functions] →
migratePerformanceIndexes() → seedInitialData()
```
لو محتاج تضيف migration جديدة مستقبلاً: أضف الجدول/العمود في الدالة
المناسبة (أو دالة جديدة)، وتأكد إنها متسجّلة في `server.js` *بعد* أي
دالة بتنشئ الجداول اللي بتعتمد عليها — هذا بالظبط النوع من الأخطاء اللي
تم اكتشافه وإصلاحه (شوف `docs/RELEASE_NOTES.md`).

## البيانات الافتراضية (Seed)
`seedInitialData()` بتنشئ (مرة واحدة بس، بتتحقق من عدم وجودها الأول):
- مستخدم admin افتراضي
- 4 مستودعات + صالة عرض
- تصنيفات منتجات افتراضية
- قاعدة عمولة افتراضية (غير مفعّلة)

## النسخ الاحتياطي والاستعادة
شوف `deploy/BACKUP_GUIDE.md` بالتفصيل.

## فهرسة الأداء (Indexes)
33 index أساسي من التطوير الأصلي + 14 index إضافي أُضيفوا في Stage 5
(`migratePerformanceIndexes()`) على أعمدة foreign key الحرجة. للتأكد إن
index معين بيتستخدم فعليًا لاستعلام معين:
```sql
EXPLAIN SELECT * FROM invoice_items WHERE invoice_id = 1;
-- المتوقع: "Bitmap Index Scan on idx_invoice_items_invoice" أو مشابه
```
