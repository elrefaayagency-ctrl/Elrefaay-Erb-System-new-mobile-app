# دليل المطوّر (Developer Guide)

## البنية المعمارية

- **Express + PostgreSQL خام (pg driver)** — بدون ORM. كل استعلام SQL
  مكتوب صراحة في الـ routes/utils. القرار ده مقصود (بساطة + تحكم كامل
  في الأداء)، مش سهو.
- **المعاملات (Transactions):** `src/db/database.js` بيوفر `transaction(fn)`
  مبني على `AsyncLocalStorage` — أي `run`/`get`/`all` جوه `fn` بينضم
  تلقائيًا لنفس الاتصال/المعاملة، من غير ما تمرر الاتصال يدويًا في كل
  استدعاء. لو الكود جوه `transaction()` بيستدعي دالة utility (زي
  `installmentEngine.js`)، الدالة دي بتنضم لنفس المعاملة تلقائيًا طالما
  بتستخدم `run`/`get`/`all` من نفس المكان.
- **الأقفال (Locking):** أي عملية بتلمس رصيد/مخزون بتستخدم
  `SELECT ... FOR UPDATE` جوه `transaction()` لمنع race conditions.
  **قاعدة صارمة:** لو عملية بتعتمد على حالة سجل (status) اتقرت *قبل*
  الدخول في transaction، لازم تتأكد منها تاني *جوه* الـ transaction بعد
  قفل الصف — الاعتماد على القراءة الأولى وحدها بيفتح نافذة race
  condition (شوف إصلاح "double-confirm" في `invoices.js` كمرجع).

## هيكل الملفات

```
src/routes/<module>.js     كل موديول في ملف واحد: router + validation + SQL
src/utils/<engine>.js      منطق عمل نقي (بدون side effects خارج ما بيُمرَّر له)
src/db/schema.js           كل تعريفات الجداول + الـ migrations، بترتيب تنفيذ محدد
src/db/database.js         pool + transaction() + run/get/all
src/middleware/auth.js     authenticate (JWT) + authorize(...roles)
```

## إضافة موديول جديد — الخطوات

1. أضف الجدول في `src/db/schema.js` (دالة migration جديدة، مسجّلة في
   `server.js` **بعد** أي جدول تاني بيعتمد عليه — شوف `docs/DATABASE_SETUP.md`)
2. أنشئ `src/routes/<module>.js`: `router.use(authenticate)` أول سطر،
   بعدها `authorize(...)` لكل route حسب الحاجة
3. أي عملية بتغيّر رصيد/مخزون: لفّها في `transaction()` مع `FOR UPDATE`
   على أي صف بتقراه وتتصرف بناءً عليه
4. سجّل الـ router في `server.js`: `app.use('/api/<module>', require('./src/routes/<module>'))`
5. أضف index لأي عمود foreign key هتستعلم/تربط عليه كتير

## الاختبار قبل أي commit

```bash
node --check src/routes/<الملف الجديد>.js   # فحص syntax سريع
node -e "require('dotenv').config(); require('express-async-errors'); require('./src/routes/<الملف>')"  # يتأكد إنه بيتحمل صح
```
لتشغيل فعلي محلي مع قاعدة بيانات تجريبية، شوف `docs/INSTALLATION.md`.

## اتفاقيات الكود

- كل رسائل الخطأ للمستخدم النهائي بالعربي
- التعليقات المهمة (خصوصاً شرح "ليه القرار ده" مش "إيه بيعمل الكود") بالعربي
- `round2()` من `src/utils/money.js` لأي عملية حسابية مالية (تفادي أخطاء
  الفاصلة العائمة في JavaScript)
