# دليل استكشاف الأخطاء (Troubleshooting)

## فشل السيرفر في الإقلاع

**`Error: JWT_SECRET غير معرّف أو قصير جداً`**
عرّف `JWT_SECRET` في `.env` بطول 32+ حرف. ولّده بـ:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**`connect ECONNREFUSED` أو `ECONNREFUSED 127.0.0.1:5432`**
`DATABASE_URL` غلط أو قاعدة البيانات مش شغالة/مش قابلة للوصول من السيرفر
ده. تأكد من نسخ الـ connection string كامل من Supabase Dashboard، وإن
الـ IP بتاع سيرفرك مش محظور في إعدادات الشبكة على Supabase (لو مفعّل
IP allowlist).

**`relation "xxx" does not exist` أثناء الإقلاع**
لو ده بيحصل على قاعدة بيانات *جديدة تمامًا*، ده يرجع لترتيب migrations
غلط في `server.js` — تأكد إنك على أحدث نسخة من الكود (تم إصلاح 3 حالات
من هذا بالظبط في Stage 5، شوف `docs/RELEASE_NOTES.md`). لو حصل على قاعدة
بيانات قديمة موجودة من زمان، فحص يدوي بـ:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public';
```

## مشاكل النسخ الاحتياطي

**`source: .env: line X: $'\r': command not found` عند تشغيل `backup.sh`**
ملف `.env` محفوظ بنهايات أسطر Windows (CRLF). السكريبتات الحالية
(`deploy/backup.sh`, `deploy/restore.sh`) بتتعامل مع الحالتين تلقائيًا —
لو لسه بتشوف الخطأ ده، تأكد إنك على أحدث نسخة من السكريبت.

**`pg_dump: command not found`**
```bash
sudo apt install -y postgresql-client
```

## مشاكل تسجيل الدخول

**"طلبات كتير جداً من هذا العنوان" (429)**
حد الـ rate limiting اتفعّل (600 طلب/15 دقيقة عام، أو 10 محاولات دخول/15
دقيقة). انتظر أو (في بيئة تطوير فقط) اضبط الحدود في `server.js`.

**نسيان كلمة مرور admin**
```sql
-- من psql مباشرة على قاعدة البيانات:
UPDATE users SET password_hash = '<bcrypt hash>' WHERE username = 'admin';
```
لتوليد bcrypt hash: `node -e "console.log(require('bcryptjs').hashSync('كلمة-المرور-الجديدة', 10))"`

## مشاكل المخزون/الفواتير

**"المخزون غير كافٍ" رغم إن الكمية ظاهرة كافية في شاشة تانية**
تأكد إن الفحص بيتم على نفس المخزن (location_id) بالظبط — المخزون منفصل
لكل مخزن، مش رقم إجمالي واحد للمنتج.

**"لا يمكن تأكيد هذه الفاتورة — تم تأكيدها بالفعل"**
هذا سلوك متعمّد (حماية من التأكيد المزدوج أُضيفت في Stage 5) — لو ظهرت
الرسالة دي بشكل متكرر وغير متوقع، تأكد إن الفرونت اند مش بيبعت طلب
التأكيد مرتين (مثلاً بسبب double-click بدون تعطيل الزرار مؤقتًا).

**"الكمية المطلوبة تتجاوز المتبقي الفعلي"**
حماية من استلام أكبر من المطلوب في أمر الشراء (أُضيفت في Stage 5) — لو
فعلاً وصلت كمية أكبر من المتفق عليه فعليًا، عدّل `qty_ordered` في أمر
الشراء الأول قبل تسجيل الاستلام.

## لسه محتاج مساعدة؟

راجع الـ logs (JSON منظّم، فيه `path` و`userId` و`stack` لكل خطأ):
```bash
# Railway
railway logs
# Docker
docker compose logs -f app
# PM2
pm2 logs najaf-erp
```
